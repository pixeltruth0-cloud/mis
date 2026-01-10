const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer();

/* ======================
   Middleware
====================== */
app.use(cors()); // simple CORS (no credentials)
app.use(express.json());

/* ======================
   Database Connection
====================== */
let db = null;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found");
} else {
  db = mysql.createConnection(process.env.DATABASE_URL);

  db.connect((err) => {
    if (err) {
      console.error("❌ DB connection failed:", err.message);
      db = null;
    } else {
      console.log("✅ DB connected successfully");
    }
  });
}

/* ======================
   Health Check
====================== */
app.get("/", (req, res) => {
  res.send("MIS Backend is running ✅");
});

/* ======================
   LOGIN API
====================== */
app.post("/login", (req, res) => {
  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const { User_Mail, Password, Role, Department } = req.body;

  if (!User_Mail || !Password || !Role || !Department) {
    return res.json({ success: false, message: "All fields required" });
  }

  const sql = `
    SELECT * FROM mis_user_data
    WHERE User_Mail = ?
      AND Password = ?
      AND Role = ?
      AND Department = ?
    LIMIT 1
  `;

  db.query(sql, [User_Mail, Password, Role, Department], (err, rows) => {
    if (err || rows.length === 0) {
      return res.json({ success: false, message: "Invalid credentials" });
    }

    const user = rows[0];
    const BASE_URL = "https://pixeltruth.com/mis";

    let redirectUrl = `${BASE_URL}/${user.Department}/dashboard`;

    if (user.Role === "HR") {
      redirectUrl = `${BASE_URL}/HR/${user.Department}/HR_dashboard`;
    } else if (user.Role === "Team_Lead") {
      redirectUrl = `${BASE_URL}/TL/${user.Department}/TL_dashboard`;
    }

    return res.json({
      success: true,
      redirectUrl,
      user: {
        User_Name: user.User_Name,
        User_Mail: user.User_Mail,
        Role: user.Role,
        Department: user.Department,
        Employee_ID: user.Employee_ID || null,
        Designation: user.Designation || null,
        Phone_Number: user.Phone_Number || null,
        Reporting_Person: user.Reporting_Person || null
      }
    });
  });
});

/* ======================
   INSERT PROJECT DATA
====================== */
app.post("/submitProjectData", upload.none(), (req, res) => {
  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const data = req.body;

  if (!data || Object.keys(data).length === 0) {
    return res.json({ success: false, message: "No data received" });
  }

  delete data.insert_id;
  delete data.created_at;

  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map(() => "?").join(",");

  const sql = `
    INSERT INTO social_media_n_website_audit_data
    (${columns.join(",")})
    VALUES (${placeholders})
  `;

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Insert Error:", err.message);
      return res.json({ success: false, message: "Insert failed" });
    }

    res.json({ success: true, message: "Data inserted successfully" });
  });
});

/* ======================
   DASHBOARD DATA (ROLE BASED - QUERY)
====================== */
app.get("/getDepartmentData", (req, res) => {
  if (!db) return res.json([]);

  const { user_mail, role, department } = req.query;
  if (!user_mail || !role || !department) return res.json([]);

  const roleUpper = role.trim().toUpperCase();
  const dept = department.trim();
  const userMail = user_mail.trim();

  let sql = "";
  let params = [];

  // 🔥 ADMIN / HR / TL / MANAGER → department data
  if (["Admin", "HR", "Team_Lead", "Manager"].includes(roleUpper)) {
    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
      WHERE TRIM(department) = ?
      ORDER BY date DESC
    `;
    params = [dept];
  } 
  // 👤 EMPLOYEE → own data
  else {
    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
      WHERE user_mail = ?
      ORDER BY date DESC
    `;
      params = [userMail];
  }

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("❌ DB Error:", err.message);
      return res.json([]);
    }
    res.json(rows);
  });
});
   
app.get("/getUsersByDepartment", (req, res) => {
  if (!db) return res.json([]);

  const { department } = req.query;

  if (!department) {
    return res.json([]);
  }

  const dept = department.trim();

  const sql = `
    SELECT 
      User_Name,
      User_Mail,
      Department
    FROM mis_user_data
    WHERE TRIM(Department) = ?
      AND Role != 'HR'
      AND Role != 'Admin'
  `;

  db.query(sql, [dept], (err, rows) => {
    if (err) {
      console.error("❌ getUsersByDepartment error:", err.message);
      return res.json([]);
    }

    res.json(rows);
  });
});


/* ======================
   ASSIGN TASK (DEPT WISE TABLE)
====================== */
app.post("/assignTask", (req, res) => {
  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const {
    user_name,
    user_mail,
    task_title,
    task_description,
    due_date,
    estimated_hours,
   department, 
    assigned_by
  } = req.body;

  if (!user_mail || !task_title || !due_date || !department || !assigned_by) {
    return res.json({ success: false, message: "Missing required fields" });
  }

  // 🔥 department → safe table name
  const tableName =
    "assigned_tasks_" +
    department
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");

  const sql = `
    INSERT INTO ${tableName}
    (user_name, user_mail, task_title, task_description,
     due_date, estimated_hours, assigned_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const values = [
    user_name,
    user_mail,
    task_title,
    task_description || "",
    due_date,
    estimated_hours || 0,
    assigned_by
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Assign task error:", err.message);
      return res.json({ success: false, message: "Task insert failed" });
    }

    res.json({ success: true, message: "Task assigned successfully" });
  });
});

/* ======================
   GET ASSIGNED TASKS (DEPT WISE)
====================== */
app.get("/getAssignedTasks", (req, res) => {
  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const { department } = req.query;

  if (!department) {
    return res.json({ success: false, message: "Department required" });
  }

  // 🔥 Same table naming logic as assignTask
  const tableName =
    "assigned_tasks_" +
    department
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_");

  const sql = `
    SELECT 
      user_name,
      user_mail,
      task_title,
      task_description,
      due_date,
      estimated_hours,
      assigned_by
    FROM ${tableName}
    ORDER BY id DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("❌ Get assigned tasks error:", err.message);
      return res.json({ success: false, data: [] });
    }

    res.json({
      success: true,
      data: rows
    });
  });
});

/* ======================
   GET MY TASKS (USER SIDE)   <-- 🔥 YAHAN PASTE KARO
====================== */
app.get("/getMyTasks", (req, res) => {
  if (!db) {
    return res.json({ success: false, data: [] });
  }

  const { department, user_mail } = req.query;

  if (!department || !user_mail) {
    return res.json({ success: false, data: [] });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    SELECT
      task_title,
      task_description,
      due_date,
      estimated_hours,
      assigned_by
    FROM ${tableName}
    WHERE user_mail = ?
    ORDER BY id DESC
  `;

  db.query(sql, [user_mail], (err, rows) => {
    if (err) {
      console.error("❌ getMyTasks error:", err.message);
      return res.json({ success: false, data: [] });
    }

    res.json({ success: true, data: rows });
  });
});

/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
