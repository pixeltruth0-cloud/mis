const express = require("express");   // ✅ ADD THIS LINE
const session = require("express-session");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");

const app = express();
const upload = multer();
;

/* ======================
   Middleware
====================== */
app.use(cors({
  origin: "https://pixeltruth.com",
  credentials: true
}));

app.set("trust proxy", 1);

app.use(express.json());

app.use(session({
  name: "pixeltruth.sid",
  secret: "pixeltruth_secret_123",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,
    sameSite: "none",
    maxAge: 1000 * 60 * 60 * 24
  }
}));


 // simple CORS (no credentials)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
   GET LOGGED IN USER INFO
====================== */

app.post("/login", (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const { User_Mail, Password, Department } = req.body;

 if (!User_Mail || !Password) {
  return res.json({ success: false, message: "Missing fields" });
}

  const sql = `
    SELECT *
    FROM mis_user_data
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

    // 🔐 Check if selected department is allowed
    const deptSql = `
      SELECT department
      FROM user_departments
      WHERE user_mail = ?
        AND department = ?
    `;

    db.query(deptSql, [user.User_Mail, Department], (err, deptRows) => {

  // ✅ Skip department validation for Super Admin
  if (user.Role !== "Director" && user.Role !== "HR Manager") {

    if (!err && deptRows.length === 0 && user.Department !== Department) {
      return res.json({
        success: false,
        message: "Unauthorized department access"
      });
    }

  }

      // ✅ Session
      req.session.user = {
        User_Name: user.User_Name,
        User_Mail: user.User_Mail,
        Role: user.Role,
        Department: Department,
        Employee_ID: user.Employee_ID
      };

   const BASE_URL = "https://pixeltruth.com/mis";
let redirectUrl = "";

if (user.Role === "Director" || user.Role === "HR Manager") {
  redirectUrl = `${BASE_URL}/super_admin/dashboard.html`;
}
else if (user.Role === "HR" || user.Role === "ADMIN") {
  redirectUrl = `${BASE_URL}/HR/${Department}/HR_dashboard.html`;
}
else if (user.Role === "Team_Lead") {
  redirectUrl = `${BASE_URL}/TL/${Department}/TL_dashboard.html`;
}
else {
  redirectUrl = `${BASE_URL}/${Department}/dashboard.html`;
}

/* ✅ Session */
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

/* ✅ Final Response */
return res.json({
  success: true,
  redirectUrl,
  user: {
    User_Name: user.User_Name,
    User_Mail: user.User_Mail,
    Role: user.Role,
    Department: Department,
    Employee_ID: user.Employee_ID || "",
    Designation: user.Designation || "",
    Phone_Number: user.Phone_Number || "",
    Reporting_Person: user.Reporting_Person || ""
  }
});
 });  // deptSql close
  });    // main query close
});      // login route close

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
   INSERT PROJECT DATA (DAILY LIMIT PROTECTED)
====================== */
app.post("/submitProjectData", upload.none(), (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  // 🔥 STEP 1 — Clean [] keys properly
  const rawData = req.body;
  const data = {};

Object.keys(rawData).forEach(key => {

  const cleanKey = key.replace(/\[\]$/, '');

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
    SELECT *
    FROM social_media_n_website_audit_data
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
        message: `Daily limit exceeded. Already used ${Math.floor(existingMinutes/60)}h ${existingMinutes%60}m`
      });
    }

    // 🔥 FIXED INSERT (STRICT ORDER MATCH)
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
  if (col.endsWith("_hours") || col.endsWith("_minutes") || col.endsWith("_Count")) {
    return data[col] ? Number(data[col]) : 0;
  }
  return data[col] ? data[col] : "";
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
});  // ✅ CLOSE fetchSql query

}); 
/* ======================
   BRAND INFRINGEMENT SUBMIT
====================== */
app.post("/submitBrandInfringement", upload.none(), (req, res) => {

  if (!db) {
    return res.json({
      success: false,
      message: "Database not connected"
    });
  }

  const data = req.body;

  if (!data || Object.keys(data).length === 0) {
    return res.json({
      success: false,
      message: "No data received"
    });
  }

  // ❌ unwanted fields remove
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
      return res.json({
        success: false,
        message: "Insert failed"
      });
    }

    res.json({
      success: true,
      message: "Brand infringement submitted successfully"
    });
  });
});

/* ======================
   MEDIA MONITORING SUBMIT
====================== */
app.post("/submitMediaMonitoring", upload.none(), (req, res) => {

  if (!db) {
    return res.json({
      success: false,
      message: "Database not connected"
    });
  }

  const data = req.body;

  // 🔒 Required fields validation
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
    return res.json({
      success: false,
      message: "Missing required fields"
    });
  }

  const allowedColumns = [
    "user_name",
    "user_mail",
    "department",
    "project",
    "sub_project",
    "brand",
    "platform",
    "type_of_work",
    "rotation",
    "work_count",
    "date",
    "remark",
    "hours",
    "minutes"
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
      return res.json({
        success: false,
        message: err.message
      });
    }

    res.json({
      success: true,
      message: "Media Monitoring submitted successfully"
    });

  });

});
/* ======================
   DASHBOARD DATA (ROLE BASED - QUERY)
====================== */
app.get("/getDepartmentData", (req, res) => {
  if (!db) return res.json([]);

  const { user_mail, role, department } = req.query;
  if (!user_mail || !role || !department) return res.json([]);

  const roleUpper = role
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  const dept = department.trim();
  const userMail = user_mail.trim();

  let sql = "";
  let params = [];

  // ✅ ADMIN / HR / TL / DIRECTOR → department data
  if (["ADMIN", "HR", "TEAM_LEAD", "DIRECTOR", "HR_MANAGER"].includes(roleUpper)) {

    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
      WHERE TRIM(department) = ?
      ORDER BY date DESC
    `;
    params = [dept];

  } 
  // 👤 EMPLOYEE → only own department data
  else {

    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
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


/* ======================
   BRAND INFRINGEMENT DASHBOARD
====================== */
app.get("/getBrandInfringementData", (req, res) => {

  if (!db) return res.json([]);

  const { user_mail, role } = req.query;

  if (!user_mail || !role) return res.json([]);

  const roleUpper = role.trim().toUpperCase();

  let sql = "";
  let params = [];

  if (["ADMIN", "HR", "TEAM_LEAD", "DIRECTOR"].includes(roleUpper)) {
    sql = `
      SELECT *
      FROM brand_infringement
      ORDER BY date DESC
    `;
  } else {
    sql = `
      SELECT *
      FROM brand_infringement
      WHERE user_mail = ?
      ORDER BY date DESC
    `;
    params = [user_mail];
  }

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("❌ BI dashboard error:", err.message);
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

/* ======================
   MEDIA MONITORING DASHBOARD
====================== */
/* ======================
   MEDIA MONITORING DASHBOARD (UPDATED)
====================== */
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

  /* ======================
     ADMIN / HR / TL / DIRECTOR
     → Full department data
  ====================== */
  if (["ADMIN","HR","TEAM_LEAD","DIRECTOR","HR_MANAGER"].includes(roleUpper)) {

    sql = `
      SELECT *
      FROM media_monitoring_data
      WHERE TRIM(department) = ?
      ORDER BY date DESC, insert_id DESC
      LIMIT 200
    `;

    params = [dept];

  }

  /* ======================
     EMPLOYEE / INTERN
     → Only own department data
  ====================== */
  else {

    sql = `
      SELECT *
      FROM media_monitoring_data
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

    // Safety: fallback date
    rows.forEach(r => {
      if (!r.date && r.created_at) {
        r.date = r.created_at;
      }
    });

    res.json({
      success: true,
      data: rows
    });

  });

});

/* ======================
   DELETE MEDIA MONITORING DATA
====================== */
app.post("/deleteMediaMonitoringData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id } = req.body;

  if (!id) return res.json({ success: false });

  const sql = `
    DELETE FROM media_monitoring_data
    WHERE insert_id = ?
  `;

  db.query(sql, [id], (err) => {
    if (err) {
      console.error("❌ deleteMediaMonitoringData error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });

});

/* ======================
   UPDATE MEDIA MONITORING DATA
====================== */
app.post("/updateMediaMonitoringData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id, column, value } = req.body;

  if (!id || !column) {
    return res.json({ success: false });
  }

  // 🔒 Allowed editable columns
  const allowedColumns = [
    "project",
    "sub_project",
    "brand",
    "platform",
    "type_of_work",
    "rotation",
    "work_count",
    "remark",
    "hours",
    "minutes",
    "date"
  ];

  if (!allowedColumns.includes(column)) {
    return res.json({ success: false, message: "Invalid column" });
  }

  const sql = `
    UPDATE media_monitoring_data
    SET ${column} = ?
    WHERE insert_id = ?
  `;

  db.query(sql, [value, id], (err) => {

    if (err) {
      console.error("❌ updateMediaMonitoringData error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });

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


// ================= ASSIGN TASK =================
app.post("/assignTask", (req, res) => {

  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const {
    users,                 // 🔥 ARRAY
    task_title,
    task_description,
    due_date,
    estimated_hours,
    priority,
    department,
    assigned_by
  } = req.body;

  if (
    !users || !Array.isArray(users) || users.length === 0 ||
    !task_title || !due_date || !priority || !department
  ) {
    return res.json({
      success: false,
      message: "Missing required fields"
    });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    INSERT INTO ${tableName}
    (
      user_name,
      user_mail,
      task_title,
      task_description,
      due_date,
      estimated_hours,
      priority,
      assigned_by,
      assigned_at
    )
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

      // jab sab users insert ho jaaye
      if (inserted === users.length) {
        if (hasError) {
          return res.json({
            success: false,
            message: "Some tasks failed to assign"
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
   DELETE DEPARTMENT DATA
====================== */
app.post("/deleteDepartmentData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id } = req.body;

  if (!id) return res.json({ success: false });

  const sql = `
    DELETE FROM social_media_n_website_audit_data
    WHERE insert_id = ?
  `;

  db.query(sql, [id], (err) => {
    if (err) {
      console.error("❌ deleteDepartmentData error:", err.message);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});

/* ======================
   UPDATE DEPARTMENT DATA
====================== */
app.post("/updateDepartmentData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id, column, value } = req.body;

  if (!id || !column) {
    return res.json({ success: false });
  }

  const allowedColumns = [
    "category",
    "count",
    "hours",
    "minutes",
    "remarks",
    "real_estimated_hours",
    "real_estimated_minutes",
    "real_estimated_remarks",
    "impact_brand",
    "impact_count",
    "impact_hours",
    "impact_minutes",
    "impact_remarks",
    "itc_platform"
  ];

  if (!allowedColumns.includes(column)) {
    return res.json({ success: false, message: "Invalid column" });
  }

  const sql = `
    UPDATE social_media_n_website_audit_data
    SET ${column} = ?
    WHERE insert_id = ?
  `;

  db.query(sql, [value, id], (err) => {
    if (err) {
      console.error("❌ updateDepartmentData error:", err.message);
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
    return res.json({ success: false, data: [] });
  }

  const { department } = req.query;

  if (!department) {
    return res.json({ success: false, data: [] });
  }

  const tableName =
    "assigned_tasks_" +
    department.toLowerCase().replace(/[^a-z0-9]+/g, "_");

  const sql = `
    SELECT
      id,
      user_name,
      user_mail,
      task_title,
      task_description,
      due_date,
      estimated_hours,
      priority,
      assigned_by,
      task_status,
      status_note,
      assigned_at
    FROM ${tableName}
    ORDER BY assigned_at DESC
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
      priority,          -- ✅ PRIORITY INCLUDED
      assigned_by,
      task_status,
      status_note
    FROM ${tableName}
    WHERE user_mail = ?          -- ✅ VERY IMPORTANT
    ORDER BY due_date ASC
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
   SUPER ADMIN DASHBOARD DATA
====================== */
/* ======================
   SUPER ADMIN DASHBOARD DATA (FILTERABLE)
====================== */
app.get("/getSuperAdminDashboardData", (req, res) => {
  if (!db) return res.json([]);

  const { department } = req.query;

  let sql = `
    SELECT *
    FROM social_media_n_website_audit_data
  `;
  let params = [];

  // 🔥 dropdown se department aaya ho to filter
  if (department && department.trim() !== "") {
    sql += " WHERE TRIM(Department) = ?";
    params.push(department.trim());
  }

  sql += " ORDER BY date DESC";

  db.query(sql, params, (err, rows) => {
    if (err) {
      console.error("❌ Super admin dashboard error:", err.message);
      return res.json([]);
    }

    // safety: date fallback
    rows.forEach(r => {
      if (!r.date && r.created_at) {
        r.date = r.created_at;
      }
    });

    res.json(rows);
  });
});

app.get("/getSummary", (req, res) => {

  if (!db) return res.json({ success:false });

  const { department, role, type, from, to } = req.query;

  // 🔐 ROLE VALIDATION
  if (role !== "Director" && role !== "HR Manager") {
    return res.status(403).json({
      success:false,
      message:"Unauthorized"
    });
  }

  if (!department) {
    return res.json({ success:false, message:"Department required" });
  }

  /* ==========================
     🔥 DYNAMIC TABLE MAPPING
  ========================== */

  let tableName = "";

  if (department === "Social_Media_N_Website_Audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (department === "Brand_Infringement") {
    tableName = "brand_infringement";
  }
  else if (department === "Media_Monitoring") {
    tableName = "media_monitoring_data";
  }
  else {
    return res.json({ success:false, message:"Invalid department" });
  }

  let sql = `SELECT * FROM ${tableName} WHERE department = ?`;
  let params = [department];

  /* ==============================
     DATE RANGE / TYPE FILTER
  ============================== */

  if (from && to) {

    sql += " AND DATE(date) BETWEEN ? AND ?";
    params.push(from, to);

  } else if (type) {

    if (type === "day") {
      sql += " AND DATE(date) = CURDATE()";
    }
    else if (type === "week") {
      sql += " AND YEARWEEK(date, 1) = YEARWEEK(CURDATE(), 1)";
    }
    else if (type === "month") {
      sql += " AND MONTH(date) = MONTH(CURDATE()) AND YEAR(date) = YEAR(CURDATE())";
    }
    else {
      return res.json({ success:false, message:"Invalid type" });
    }

  }

  sql += " ORDER BY date DESC";

  db.query(sql, params, (err, rows) => {

    if (err) {
      console.error("❌ Summary Error:", err.message);
      return res.json({ success:false });
    }

    let totalMinutes = 0;

    rows.forEach(row => {

      Object.keys(row).forEach(key => {

        // ✅ Social Media style (_hours/_minutes)
        if (key.endsWith("_hours")) {
          totalMinutes += Number(row[key] || 0) * 60;
        }

        if (key.endsWith("_minutes")) {
          totalMinutes += Number(row[key] || 0);
        }

        // ✅ Media Monitoring style (hours/minutes)
        if (key === "hours") {
          totalMinutes += Number(row[key] || 0) * 60;
        }

        if (key === "minutes") {
          totalMinutes += Number(row[key] || 0);
        }

      });

    });

    res.json({
      success:true,
      totalEntries: rows.length,
      totalHours: Math.floor(totalMinutes / 60),
      totalMinutes: totalMinutes % 60,
      rawData: rows
    });

  });

});
/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
