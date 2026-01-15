const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const app = express();
const upload = multer();

/* ======================
   Middleware
====================== */
app.use(cors({
  origin: "*",
  credentials: true
}));
 // simple CORS (no credentials)
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
   ADD USER (HR) ✅ FIXED
====================== */
app.post("/addUser", upload.none(), (req, res) => {
  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const {
    New_Employee_ID,
    New_Name,
    New_User_Mail,
    New_Designation,
    New_Reporting_Person,
    New_Role,
    New_Number,
    New_Password
  } = req.body;

  if (!New_Employee_ID || !New_Name || !New_User_Mail || !New_Role || !New_Password) {
    return res.json({ success: false, message: "Missing fields" });
  }

  const sql = `
    INSERT INTO mis_user_data (
      Employee_ID,
      User_Name,
      User_Mail,
      Designation,
      Reporting_Person,
      Role,
      Phone_Number,
      Password,
      Department,
      is_archived
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `;

  const values = [
    New_Employee_ID,
    New_Name,
    New_User_Mail,
    New_Designation || "",
    New_Reporting_Person || "",
    New_Role,
    New_Number || "",
    New_Password,
    req.body.Department || "Social_Media_N_Website_Audit"
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Add User Error:", err.message);
      return res.json({ success: false });
    }

    console.log("✅ User added:", New_User_Mail);
    res.json({ success: true });
  });
});

/* ======================
   DELETE USER
====================== */
app.post("/deleteUser", (req, res) => {
  if (!db) {
    return res.json({ success: false });
  }

  const { Employee_ID, User_Mail } = req.body;

  if (!Employee_ID || !User_Mail) {
    return res.json({ success: false });
  }

  const sql = `
    DELETE FROM mis_user_data
    WHERE Employee_ID = ? AND User_Mail = ?
  `;

  db.query(sql, [Employee_ID, User_Mail], (err) => {
    if (err) {
      console.error("❌ Delete User Error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});
/* ======================
   ARCHIVE USER (SOFT DELETE)
====================== */
app.post("/archiveUser", (req, res) => {
  if (!db) {
    return res.json({ success: false });
  }

  const { Employee_ID } = req.body;

  const sql = `
    UPDATE mis_user_data
    SET is_archived = 1
    WHERE Employee_ID = ?
  `;

  db.query(sql, [Employee_ID], (err) => {
    if (err) {
      console.error("❌ Archive Error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
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
if (["ADMIN", "HR", "TEAM_LEAD", "MANAGER"].includes(roleUpper)) {
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
    rows.forEach(r => {
  if (!r.date && r.created_at) {
    r.date = r.created_at;
  }
});

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
    return res.json({ success: false, message: "Missing fields" });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});
app.post("/updateTaskStatus", (req, res) => {

  if (!db) return res.json({ success:false });

  const { task_id, department, task_status, status_note } = req.body;

  if (!task_id || !department || !task_status) {
    return res.json({ success:false });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    UPDATE ${tableName}
    SET task_status = ?, status_note = ?
    WHERE id = ?
  `;

  db.query(sql, [task_status, status_note || "", task_id], err => {
    if (err) {
      console.error("❌ Status update error:", err);
      return res.json({ success:false });
    }
    res.json({ success:true });
  });
});

app.post("/updateTask", (req, res) => {
  if (!db) return res.json({ success: false });

  const {
    task_id,
    user_name,
    user_mail,
    task_title,
    task_description,
    due_date,
    estimated_hours,
    department
  } = req.body;

  if (!task_id || !department) {
    return res.json({ success: false });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    UPDATE ${tableName}
    SET
      user_name = ?,
      user_mail = ?,
      task_title = ?,
      task_description = ?,
      due_date = ?,
      estimated_hours = ?
    WHERE id = ?
  `;

  const values = [
    user_name,
    user_mail,
    task_title,
    task_description || "",
    due_date,
    estimated_hours || 0,
    task_id
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ updateTask error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});
app.post("/deleteTask", (req, res) => {
  if (!db) return res.json({ success: false });

  const { task_id, department } = req.body;
  if (!task_id || !department) return res.json({ success: false });

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `DELETE FROM ${tableName} WHERE id = ?`;

  db.query(sql, [task_id], (err) => {
    if (err) {
      console.error("❌ deleteTask error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
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
  id,
  user_name,
  user_mail,
  task_title,
  task_description,
  due_date,
  estimated_hours,
  assigned_by,
  task_status,
  status_note
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
app.get("/getTaskById", (req, res) => {
  if (!db) return res.json({});

  const { id, department } = req.query;
  if (!id || !department) return res.json({});

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `SELECT * FROM ${tableName} WHERE id = ? LIMIT 1`;

  db.query(sql, [id], (err, rows) => {
    if (err || rows.length === 0) {
      console.error("❌ getTaskById error:", err?.message);
      return res.json({});
    }

    res.json(rows[0]);
  });
});

/* ======================
   TL DASHBOARD DATA (DEPARTMENT WISE)
====================== */
app.get("/getTLDashboardData", (req, res) => {
  if (!db) {
    return res.json({ success: false });
  }

  const { department } = req.query;

  if (!department) {
    return res.json({ success: false });
  }

  const dept = department.trim();

  const tableName =
    "assigned_tasks_" +
    dept.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const today = new Date().toISOString().split("T")[0];

  const teamCountSql = `
    SELECT COUNT(*) AS count
    FROM mis_user_data
    WHERE Department = ?
      AND Role NOT IN ('HR', 'Admin', 'Team_Lead')
      AND is_archived = 0
  `;

  const totalTasksSql = `SELECT COUNT(*) AS count FROM ${tableName}`;

  const todayTasksSql = `
    SELECT COUNT(*) AS count
    FROM ${tableName}
    WHERE DATE(created_at) = ?
  `;

  const pendingSql = `
    SELECT COUNT(*) AS count
    FROM ${tableName}
    WHERE task_status = 'Pending'
  `;

  const completedSql = `
    SELECT COUNT(*) AS count
    FROM ${tableName}
    WHERE task_status = 'Completed'
  `;

  db.query(teamCountSql, [dept], (err, teamRows) => {
    if (err) {
      console.error("❌ teamCount error:", err.message);
      return res.json({ success: false });
    }

    db.query(totalTasksSql, (err, totalRows) => {
      if (err) {
        console.error("❌ totalTasks error:", err.message);
        return res.json({ success: false });
      }

      db.query(todayTasksSql, [today], (err, todayRows) => {
        if (err) {
          console.error("❌ todayTasks error:", err.message);
          return res.json({ success: false });
        }

        db.query(pendingSql, (err, pendingRows) => {
          if (err) {
            console.error("❌ pendingTasks error:", err.message);
            return res.json({ success: false });
          }

          db.query(completedSql, (err, completedRows) => {
            if (err) {
              console.error("❌ completedTasks error:", err.message);
              return res.json({ success: false });
            }

            res.json({
              success: true,
              teamCount: teamRows[0].count,
              totalTasks: totalRows[0].count,
              todayTasks: todayRows[0].count,
              pendingTasks: pendingRows[0].count,
              completedTasks: completedRows[0].count
            });
          });
        });
      });
    });
  });
});

/* ======================
   GET MY TASKS (USER SIDE) ✅ FIXED
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
      id,
      task_title,
      task_description,
      due_date,
      estimated_hours,
      assigned_by,
      task_status,
      status_note
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
   GET USERS (HR) – NON ARCHIVED ONLY
====================== */
app.get("/getDepartmentUsers", (req, res) => {
  if (!db) return res.json([]);

  const sql = `
    SELECT 
      Employee_ID,
      User_Name,
      User_Mail,
      Designation,
      Department,
      Role,
      Phone_Number,
      Reporting_Person
    FROM mis_user_data
    WHERE is_archived = 0
    ORDER BY Employee_ID DESC
  `;

  db.query(sql, (err, rows) => {
    if (err) {
      console.error("❌ getDepartmentUsers error:", err.message);
      return res.json([]);
    }
    res.json(rows);
  });
});


/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
