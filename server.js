const express = require("express");
const session = require("express-session");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer();

/* ====================== Middleware ====================== */

app.use(cors({
  origin: "https://pixeltruth.com",
  credentials: true
}));

app.set("trust proxy", 1);

const isProduction = process.env.NODE_ENV === "production";

app.use(session({
  name: "pixeltruth.sid",
  secret: "pixeltruth_secret_123",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ====================== Database Connection ====================== */

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

/* ====================== Health Check ====================== */

app.get("/", (req, res) => {
  res.send("MIS Backend is running ✅");
});

/* ====================== LOGIN ====================== */

app.post("/login", (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const { User_Mail, Password, Department } = req.body;

  if (!User_Mail || !Password) {
    return res.json({ success: false, message: "Missing fields" });
  }

  const sql = `
    SELECT * FROM mis_user_data
    WHERE User_Mail = ?
    AND Password = ?
    AND is_archived = 0
    LIMIT 1
  `;

  db.query(sql, [User_Mail, Password], (err, rows) => {

    if (err || rows.length === 0) {
      return res.json({ success: false, message: "Invalid credentials" });
    }

    const user = rows[0];

    const deptSql = `
      SELECT department FROM user_departments
      WHERE user_mail = ? AND department = ?
    `;

    db.query(deptSql, [user.User_Mail, Department], (err, deptRows) => {

      if (user.Role !== "Director" && user.Role !== "HR Manager") {
        if (!err && deptRows.length === 0 && user.Department !== Department) {
          return res.json({
            success: false,
            message: "Unauthorized department access"
          });
        }
      }

      req.session.user = {
        User_Name: user.User_Name,
        User_Mail: user.User_Mail,
        Role: user.Role,
        Department: Department,
        Employee_ID: user.Employee_ID,
        Designation: user.Designation,
        Phone_Number: user.Phone_Number,
        Reporting_Person: user.Reporting_Person
      };

      const BASE_URL = "https://pixeltruth.com/mis";
      let redirectUrl = "";

      if (user.Role === "Director" || user.Role === "HR Manager") {
        redirectUrl = `${BASE_URL}/super_admin/dashboard.html`;
      } else if (user.Role === "HR" || user.Role === "Admin") {
        redirectUrl = `${BASE_URL}/HR/${Department}/HR_dashboard.html`;
      } else if (user.Role === "Team_Lead") {
        redirectUrl = `${BASE_URL}/TL/${Department}/TL_dashboard.html`;
      } else {
        redirectUrl = `${BASE_URL}/${Department}/dashboard.html`;
      }

      return res.json({
        success: true,
        redirectUrl,
        user: req.session.user
      });

    });

  });

});
/* ====================== ADD USER ====================== */

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
    New_Password,
    Department
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
    Department || "Social_Media_N_Website_Audit"
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Add User Error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });

});
/* ====================== DELETE USER ====================== */

app.post("/deleteUser", (req, res) => {

  if (!db) return res.json({ success: false });

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
/* ====================== ARCHIVE USER ====================== */

app.post("/archiveUser", (req, res) => {

  if (!db) return res.json({ success: false });

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
/* ====================== GET DEPARTMENT USERS ====================== */

app.get("/getDepartmentUsers", (req, res) => {

  if (!db) return res.json([]);

  const sql = `
    SELECT Employee_ID,
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
/* ====================== SUBMIT PROJECT DATA ====================== */

app.post("/submitProjectData", upload.none(), (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  /* 🔥 STEP 1 – Clean [] keys properly */
  const rawData = req.body;
  const data = {};

  Object.keys(rawData).forEach(key => {

    const cleanKey = key.replace(/\[\]$/, "");

    if (Array.isArray(rawData[key])) {

      if (
        cleanKey.endsWith("_hours") ||
        cleanKey.endsWith("_minutes") ||
        cleanKey.endsWith("_Count")
      ) {
        data[cleanKey] = rawData[key]
          .map(v => Number(v) || 0)
          .reduce((a, b) => a + b, 0);
      } else {
        data[cleanKey] = rawData[key].join(", ");
      }

    } else {
      data[cleanKey] = rawData[key];
    }

  });

  const { user_mail, department, date } = data;

  if (!user_mail || !department || !date) {
    return res.json({ success: false, message: "Missing required fields" });
  }

  const MAX_MINUTES = 8 * 60 + 20;

  const fetchSql = `
    SELECT * FROM social_media_n_website_audit_data
    WHERE user_mail = ?
    AND department = ?
    AND date = ?
  `;

  db.query(fetchSql, [user_mail, department, date], (err, rows) => {

    if (err) {
      console.error("❌ Fetch Error:", err.message);
      return res.json({ success: false });
    }

    let existingMinutes = 0;

    rows.forEach(row => {
      Object.keys(row).forEach(key => {

        if (key.endsWith("_hours")) {
          existingMinutes += Number(row[key] || 0) * 60;
        }

        if (key.endsWith("_minutes")) {
          existingMinutes += Number(row[key] || 0);
        }

      });
    });

    let newMinutes = 0;

    Object.keys(data).forEach(key => {

      if (key.endsWith("_hours")) {
        newMinutes += Number(data[key] || 0) * 60;
      }

      if (key.endsWith("_minutes")) {
        newMinutes += Number(data[key] || 0);
      }

    });

    if (existingMinutes + newMinutes > MAX_MINUTES) {
      return res.json({
        success: false,
        message: `Daily limit exceeded. Already used ${Math.floor(existingMinutes / 60)}h ${existingMinutes % 60}m`
      });
    }

    /* 🔥 STRICT INSERT ORDER */

    const allowedColumns = [
      "user_name","user_mail","department","date",
      "Website_Audit_Brand","Website_Audit_Type_Of_Task","Website_Audit_hours","Website_Audit_minutes","Website_Audit_Remark","Website_Audit_Status",
      "Social_Media_Audit_Brand","Social_Media_Audit_Type_Of_Task","Social_Media_Audit_hours","Social_Media_Audit_minutes","Social_Media_Audit_Remark","Social_Media_Audit_Status",
      "Stationary_Brand","Stationary_Project","Stationary_Count","Stationary_hours","Stationary_minutes","Stationary_Remark",
      "Real_estimated_Brand","Real_estimated_Categories","Real_estimated_Count","Real_estimated_hours","Real_estimated_minutes","Real_estimated_Remark",
      "Incent_Brand","Incent_Count","Incent_Eastat_hours","Incent_Eastat_minutes","Incent_Remark",
      "ITC_Cigarette_Platform","ITC_Cigarette_Count","ITC_Cigarette_hours","ITC_Cigarette_minutes","ITC_Cigarette_Remark"
    ];

    const values = allowedColumns.map(col => {

      if (
        col.endsWith("_hours") ||
        col.endsWith("_minutes") ||
        col.endsWith("_Count")
      ) {
        return data[col] ? Number(data[col]) : 0;
      }

      return data[col] || "";
    });

    const placeholders = allowedColumns.map(() => "?").join(",");

    const insertSql = `
      INSERT INTO social_media_n_website_audit_data
      (${allowedColumns.join(",")})
      VALUES (${placeholders})
    `;

    db.query(insertSql, values, (err) => {

      if (err) {
        console.error("❌ FINAL INSERT ERROR:", err.message);
        return res.json({ success: false, message: err.message });
      }

      const totalUsedMinutes = existingMinutes + newMinutes;
      const remainingMinutes = MAX_MINUTES - totalUsedMinutes;

      return res.json({
        success: true,
        message: "Data submitted successfully",
        remainingHours: Math.floor(remainingMinutes / 60),
        remainingMinutes: remainingMinutes % 60
      });

    });

  });

});
/* ====================== SUBMIT BRAND INFRINGEMENT ====================== */

app.post("/submitBrandInfringement", upload.none(), (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const data = req.body;

  if (!data || Object.keys(data).length === 0) {
    return res.json({ success: false, message: "No data received" });
  }

  delete data.id;
  delete data.insert_id;
  delete data.created_at;

  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map(() => "?").join(",");

  const sql = `
    INSERT INTO brand_infringement
    (${columns.join(",")})
    VALUES (${placeholders})
  `;

  db.query(sql, values, (err) => {

    if (err) {
      console.error("❌ Brand Infringement Insert Error:", err.message);
      return res.json({ success: false, message: "Insert failed" });
    }

    res.json({
      success: true,
      message: "Brand infringement submitted successfully"
    });

  });

});
/* ====================== SUBMIT MEDIA MONITORING ====================== */

app.post("/submitMediaMonitoring", upload.none(), (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const data = req.body;

  if (
    !data.user_name ||
    !data.user_mail ||
    !data.department ||
    !data.project ||
    !data.sub_project ||
    !data.brand ||
    !data.platform ||
    !data.type_of_work ||
    !data.rotation ||
    !data.date
  ) {
    return res.json({ success: false, message: "Missing required fields" });
  }

  const allowedColumns = [
    "user_name","user_mail","department",
    "project","sub_project","brand","platform",
    "type_of_work","rotation","work_count",
    "date","remark","hours","minutes"
  ];

  const values = allowedColumns.map(col => {

    if (col === "work_count" || col === "hours" || col === "minutes") {
      return Number(data[col]) || 0;
    }

    return data[col] || "";
  });

  const placeholders = allowedColumns.map(() => "?").join(",");

  const sql = `
    INSERT INTO media_monitoring_data
    (${allowedColumns.join(",")})
    VALUES (${placeholders})
  `;

  db.query(sql, values, (err) => {

    if (err) {
      console.error("❌ Media Monitoring Insert Error:", err.message);
      return res.json({ success: false, message: err.message });
    }

    res.json({
      success: true,
      message: "Media Monitoring submitted successfully"
    });

  });

});
/* ====================== GET DEPARTMENT DATA ====================== */

app.get("/getDepartmentData", (req, res) => {

  if (!db) return res.json([]);

  const { user_mail, role, department } = req.query;

  if (!user_mail || !role || !department) {
    return res.json([]);
  }

  const roleUpper = role.trim().toUpperCase().replace(/\s+/g, "_");
  const dept = department.trim();
  const userMail = user_mail.trim();

  let sql = "";
  let params = [];

  if (["ADMIN","HR","TEAM_LEAD","DIRECTOR","HR_MANAGER"].includes(roleUpper)) {

    sql = `
      SELECT * FROM social_media_n_website_audit_data
      WHERE TRIM(department) = ?
      ORDER BY date DESC
    `;
    params = [dept];

  } else {

    sql = `
      SELECT * FROM social_media_n_website_audit_data
      WHERE user_mail = ?
      AND TRIM(department) = ?
      ORDER BY date DESC
    `;
    params = [userMail, dept];
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
/* ====================== GET MEDIA MONITORING DATA ====================== */

app.get("/getMediaMonitoringData", (req, res) => {

  if (!db) {
    return res.json({ success: false, data: [] });
  }

  const { user_mail, role, department } = req.query;

  if (!user_mail || !role || !department) {
    return res.json({ success: false, data: [] });
  }

  const roleUpper = role.trim().toUpperCase();
  const dept = department.trim();
  const userMail = user_mail.trim();

  let sql = "";
  let params = [];

  if (["ADMIN","HR","TEAM_LEAD","DIRECTOR","HR_MANAGER"].includes(roleUpper)) {

    sql = `
      SELECT * FROM media_monitoring_data
      WHERE TRIM(department) = ?
      ORDER BY date DESC, insert_id DESC
      LIMIT 200
    `;
    params = [dept];

  } else {

    sql = `
      SELECT * FROM media_monitoring_data
      WHERE user_mail = ?
      AND TRIM(department) = ?
      ORDER BY date DESC, insert_id DESC
      LIMIT 200
    `;
    params = [userMail, dept];
  }

  db.query(sql, params, (err, rows) => {

    if (err) {
      console.error("❌ Media Monitoring Fetch Error:", err.message);
      return res.json({ success: false, data: [] });
    }

    rows.forEach(r => {
      if (!r.date && r.created_at) {
        r.date = r.created_at;
      }
    });

    res.json({ success: true, data: rows });

  });

});
/* ====================== ASSIGN TASK ====================== */

app.post("/assignTask", (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const {
    users,
    task_title,
    task_description,
    due_date,
    estimated_hours,
    priority,
    department,
    assigned_by
  } = req.body;

  if (!users || !Array.isArray(users) || users.length === 0 || !task_title || !due_date || !priority || !department) {
    return res.json({ success: false, message: "Missing required fields" });
  }

  const tableName = "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    INSERT INTO ${tableName}
    (user_name,user_mail,task_title,task_description,due_date,estimated_hours,priority,assigned_by,assigned_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
  `;

  let inserted = 0;
  let hasError = false;

  users.forEach(u => {

    const values = [
      u.user_name,
      u.user_mail,
      task_title,
      task_description || "",
      due_date,
      estimated_hours || 0,
      priority,
      assigned_by
    ];

    db.query(sql, values, err => {

      if (err) {
        console.error("❌ Bulk assign error:", err.message);
        hasError = true;
      }

      inserted++;

      if (inserted === users.length) {

        if (hasError) {
          return res.json({
            success: false,
            message: "Some tasks failed"
          });
        }

        return res.json({ success: true });

      }

    });

  });

});
app.post("/updateTaskStatus", (req, res) => {

  if (!db) return res.json({ success:false });

  const { task_id, department, task_status, status_note } = req.body;

  if (!task_id || !department || !task_status) {
    return res.json({ success:false });
  }

  const tableName = "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    UPDATE ${tableName}
    SET task_status = ?, status_note = ?
    WHERE id = ?
  `;

  db.query(sql, [task_status, status_note || "", task_id], err => {

    if (err) {
      console.error("❌ Status update error:", err.message);
      return res.json({ success:false });
    }

    res.json({ success:true });

  });

});
app.get("/getMyTasks", (req, res) => {

  if (!db) return res.json({ success:false, data:[] });

  const { department, user_mail } = req.query;

  if (!department || !user_mail) {
    return res.json({ success:false, data:[] });
  }

  const tableName = "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    SELECT id, task_title, task_description, due_date,
           estimated_hours, priority,
           assigned_by, task_status, status_note
    FROM ${tableName}
    WHERE user_mail = ?
    ORDER BY due_date ASC
  `;

  db.query(sql, [user_mail], (err, rows) => {

    if (err) {
      console.error("❌ getMyTasks error:", err.message);
      return res.json({ success:false, data:[] });
    }

    res.json({ success:true, data:rows });

  });

});
/* ====================== SUPER ADMIN DASHBOARD ====================== */

app.get("/getSuperAdminDashboardData", (req, res) => {

  if (!db) return res.json({ success:false });

  const today = new Date().toISOString().split("T")[0];

  const usersQuery = `
    SELECT User_Mail, Department
    FROM mis_user_data
    WHERE is_archived = 0
    AND Role NOT IN ('HR','Admin','Team_Lead','Director','HR Manager')
  `;

  db.query(usersQuery, (err, users) => {

    if (err) {
      console.error("❌ Users Query Error:", err.message);
      return res.json({ success:false });
    }

    if (!users.length) {
      return res.json({ success:true, summary:{}, departments:[] });
    }

    const submissionQuery = `
      SELECT DISTINCT user_mail FROM social_media_n_website_audit_data WHERE DATE(created_at)=?
      UNION
      SELECT DISTINCT user_mail FROM media_monitoring_data WHERE DATE(created_at)=?
      UNION
      SELECT DISTINCT user_mail FROM brand_infringement WHERE DATE(created_at)=?
    `;

    db.query(submissionQuery, [today,today,today], (err, submissions) => {

      if (err) {
        console.error("❌ Submission Error:", err.message);
        return res.json({ success:false });
      }

      const submittedSet = new Set(submissions.map(s => s.user_mail));

      let departmentMap = {};

      users.forEach(u => {

        if (!departmentMap[u.Department]) {
          departmentMap[u.Department] = {
            department: u.Department,
            totalEmployees: 0,
            submittedToday: 0
          };
        }

        departmentMap[u.Department].totalEmployees++;

        if (submittedSet.has(u.User_Mail)) {
          departmentMap[u.Department].submittedToday++;
        }

      });

      const departments = Object.values(departmentMap)
        .map(d => ({
          ...d,
          missing: d.totalEmployees - d.submittedToday
        }));

      res.json({
        success:true,
        summary:{
          totalDepartments: departments.length,
          totalEmployees: users.length,
          totalSubmittedToday: submissions.length
        },
        departments
      });

    });

  });

});
/* ====================== SERVER START ====================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
