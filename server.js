const express = require("express"); 
const session = require("express-session");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const helmet = require("helmet");
const nodemailer = require("nodemailer");

const app = express();
const upload = multer();

/* ======================
   Middleware
====================== */
app.use(helmet()); 
app.use(cors({
  origin: "https://pixeltruth.com",
  credentials: true
}));
app.set("trust proxy", 1);


const isProduction = true;

app.use(session({
  name: "pixeltruth.sid",
  secret: "pixeltruth_secret_123",
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    secure: true,
    sameSite: "none",
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24
  }
}));

 // simple CORS (no credentials)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ======================
   Database Connection
====================== */
/* ======================
   Database Connection (FIXED - POOL)
====================== */
let db = null;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found");
} else {

  db = mysql.createPool({
    uri: process.env.DATABASE_URL,
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
  });

  console.log("✅ DB Pool connected");

  // Programmatic migration to ensure user_mail unique constraint is updated to (group_id, user_mail)
  const migrateGroupConstraints = () => {
    db.query("SHOW INDEX FROM shift_group_members", (err, indexes) => {
      if (err) {
        console.error("❌ Error checking shift_group_members indexes:", err);
        return;
      }
      
      const keyNames = [...new Set(indexes.map(idx => idx.Key_name))];
      const uniqueKeysOnUserMailAlone = [];
      let hasUniqueGroupMember = false;
      
      keyNames.forEach(keyName => {
        const keyRows = indexes.filter(idx => idx.Key_name === keyName);
        const isUnique = keyRows[0].Non_unique === 0;
        if (keyName === 'unique_group_member') {
          hasUniqueGroupMember = true;
        } else if (isUnique && keyRows.length === 1 && keyRows[0].Column_name === 'user_mail') {
          uniqueKeysOnUserMailAlone.push(keyName);
        }
      });

      if (uniqueKeysOnUserMailAlone.length > 0) {
        console.log("ℹ️ Found unique constraints on user_mail alone:", uniqueKeysOnUserMailAlone);
        const dropNext = (idx) => {
          if (idx >= uniqueKeysOnUserMailAlone.length) {
            if (!hasUniqueGroupMember) {
              console.log("ℹ️ Adding unique constraint (group_id, user_mail)...");
              db.query("ALTER TABLE shift_group_members ADD UNIQUE KEY unique_group_member (group_id, user_mail)", (err) => {
                if (err) console.error("❌ Failed to add unique_group_member constraint:", err);
                else console.log("✅ Successfully added unique_group_member constraint!");
              });
            }
            return;
          }
          const keyName = uniqueKeysOnUserMailAlone[idx];
          db.query(`ALTER TABLE shift_group_members DROP INDEX \`${keyName}\``, (err) => {
            if (err) console.error(`❌ Failed to drop unique index ${keyName}:`, err);
            else console.log(`✅ Successfully dropped unique index ${keyName}!`);
            dropNext(idx + 1);
          });
        };
        dropNext(0);
      } else if (!hasUniqueGroupMember) {
        console.log("ℹ️ Adding unique constraint (group_id, user_mail)...");
        db.query("ALTER TABLE shift_group_members ADD UNIQUE KEY unique_group_member (group_id, user_mail)", (err) => {
          if (err) console.error("❌ Failed to add unique_group_member constraint:", err);
          else console.log("✅ Successfully added unique_group_member constraint!");
        });
      } else {
        console.log("✅ DB schema constraints for shift_group_members are already up to date.");
      }
    });
  };
  migrateGroupConstraints();

  const migrateCronTable = () => {
    db.query(`
      CREATE TABLE IF NOT EXISTS \`mis_cron_status\` (
        \`id\` int NOT NULL AUTO_INCREMENT,
        \`last_run_date\` varchar(50) NOT NULL,
        PRIMARY KEY (\`id\`)
      )
    `, (err) => {
      if (err) console.error("❌ Error migrating mis_cron_status table:", err);
      else console.log("✅ DB schema verification complete for mis_cron_status.");
    });
  };
  migrateCronTable();

  // 🔥 Error handling (VERY IMPORTANT)
  db.on("error", (err) => {
    console.error("❌ DB Pool Error:", err.message);
  });

}

/* ======================
   Health Check
====================== */
app.get("/", (req, res) => {
  res.send("MIS Backend is running ✅");
});

/* ======================
   SESSION CHECK API ✅
====================== */

app.get("/api/check-session", (req, res) => {
  if (req.session && req.session.user) {
    res.json({ loggedIn: true });
  } else {
    res.json({ loggedIn: false });
  }
});
/* ======================
   GET LOGGED IN USER INFO
====================== */

app.post("/login", (req, res) => {
  runDuesCheckIfNeeded();

  if (!db) {
    return res.json({ success: false, message: "Database not connected" });
  }

  const { User_Mail, Password, Department, Role } = req.body;

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

// ✅ CLEAN ROLES (NO LOWERCASE)
const roles = user.Role
  .split(",")
  .map(r => r.trim());

// ✅ SELECTED ROLE
const selectedRole = Role.trim();

// ✅ VALIDATION
if (!roles.includes(selectedRole)) {
  console.log("DB Role:", user.Role);
  console.log("Roles Array:", roles);
  console.log("Selected Role:", selectedRole);

  return res.json({
    success: false,
    message: "Invalid role selected"
  });
}

    // 🔐 Check if selected department is allowed
    const deptSql = `
      SELECT department
      FROM user_departments
      WHERE user_mail = ?
        AND department = ?
    `;

    db.query(deptSql, [user.User_Mail, Department], (err, deptRows) => {

  // ✅ Skip department validation for Super Admin
if (Role === "Employee" || Role === "Intern") {

    // 🔥 allow if main department matches
  if (user.Department === Department) {
    // OK
  }

  // 🔥 allow if mapping exists
  else if (!err && deptRows.length > 0) {
    // OK
  }

  else {
    return res.json({
      success: false,
      message: "Unauthorized department access"
    });
  }

}

// ✅ TL / Admin / HR / Director → NO CHECK AT ALL

   const BASE_URL = "https://pixeltruth.com/mis";
let redirectUrl = "";

if (roles.includes("Director") || roles.includes("HR Manager")) {
  redirectUrl = `${BASE_URL}/super_admin/dashboard.html`;
}

else if (roles.includes("HR")) {
  redirectUrl = `${BASE_URL}/HR/${Department}/HR_dashboard.html`;
}

else if (selectedRole === "Admin") {
  redirectUrl = `${BASE_URL}/Admin/${Department}/Admin_dashboard.html`;
}

// 🔥 USER SELECTED ROLE BASED
else if (selectedRole === "Team_Lead"){
  redirectUrl = `${BASE_URL}/TL/${Department}/TL_dashboard.html`;
}

else if (
  selectedRole === "Employee" ||
  selectedRole === "Intern"
) {
  redirectUrl = `${BASE_URL}/${Department}/dashboard.html`;
}

else {
  return res.json({
    success: false,
    message: "Invalid role selection"
  });
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

req.session.save(() => {

  console.log("SESSION SAVED:", req.session.user);

  res.json({
    success: true,
    redirectUrl,
    user: req.session.user
  });
});
 });  // deptSql close
  });    // main query close
});      // login route close

/* ======================
   GET USER INFO (SESSION)
====================== */
app.get("/getDepartmentUsers", (req, res) => {

  if (!db) return res.json([]);

  const { department, role } = req.query;

  let sql = "";
  let params = [];

  /* DIRECTOR / HR MANAGER → ALL USERS */

  if (role === "Director" || role === "HR Manager") {

    sql = `
      SELECT 
        Employee_ID,
        User_Name,
        User_Mail,
        Designation,
        Department,
        Role,
        Phone_Number,
        Reporting_Person,
        is_archived
      FROM mis_user_data
      ORDER BY Department, Employee_ID DESC
    `;

  }

  /* HR / ADMIN → ONLY THEIR DEPARTMENT */

else if (role === "HR" || role === "Admin") {

  sql = `
    SELECT DISTINCT
      u.Employee_ID,
      u.User_Name,
      u.User_Mail,
      u.Designation,
      u.Department,
      u.Role,
      u.Phone_Number,
      u.Reporting_Person,
      u.is_archived
    FROM mis_user_data u
    LEFT JOIN user_departments d
      ON u.User_Mail = d.user_mail
    WHERE
      u.is_archived = 0
      AND (
        LOWER(TRIM(u.Department)) = LOWER(?)
        OR LOWER(TRIM(d.department)) = LOWER(?)
      )
    ORDER BY u.Employee_ID DESC
  `;

  params = [department, department];

}

  else {
    return res.json([]);
  }

db.query(sql, params, (err, rows) => {

  if (err) {
    console.error("❌ Common Dashboard Error:", err.message);
    return res.json([]);
  }

  // ✅ FIX DATE FORMAT
  rows.forEach(row => {

    if (row.date) {
      row.date = row.date.toISOString().split("T")[0];
    }

    if (row.created_at) {
      row.created_at = row.created_at.toISOString().split("T")[0];
    }

  });

  res.json(rows);
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

  const rawDept = req.body.Department || req.body.department || "";
  const userDept = (rawDept && rawDept.trim()) ? rawDept.trim() : "Media_Monitoring";

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
    New_Employee_ID.trim(),
    New_Name.trim(),
    New_User_Mail.trim(),
    New_Designation || "",
    New_Reporting_Person || "",
    New_Role,
    New_Number || "",
    New_Password,
    userDept
  ];

  db.query(sql, values, (err) => {
    if (err) {
      console.error("❌ Add User Error:", err.message);
      let errMsg = "Failed to add user";
      if (err.code === "ER_DUP_ENTRY" || (err.message && err.message.includes("Duplicate entry"))) {
        errMsg = `User with email "${New_User_Mail}" already exists!`;
      } else if (err.sqlMessage) {
        errMsg = err.sqlMessage;
      }
      return res.json({ success: false, message: errMsg });
    }

    // Also ensure department access mapping exists in user_departments
    const deptMapSql = `INSERT IGNORE INTO user_departments (user_mail, department) VALUES (?, ?)`;
    db.query(deptMapSql, [New_User_Mail.trim(), userDept], (deptErr) => {
      if (deptErr) {
        console.warn("⚠️ user_departments mapping insert warning:", deptErr.message);
      }
      res.json({ success: true, message: "User added successfully" });
    });
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

  console.log("===== ARCHIVE API HIT =====");
  console.log("BODY:", req.body);

  if (!db) {
    return res.json({ success: false, message: "DB not connected" });
  }

  const { Employee_ID } = req.body;

  if (!Employee_ID) {
    return res.json({
      success: false,
      message: "Employee_ID missing"
    });
  }

  const sql = `
    UPDATE mis_user_data
    SET is_archived = 1
    WHERE Employee_ID = ?
  `;

  db.query(sql, [Employee_ID], (err, result) => {

    console.log("SQL ERROR:", err);
    console.log("RESULT:", result);

    if (err) {
      return res.json({
        success: false,
        error: err.message
      });
    }

    res.json({
      success: true,
      affectedRows: result.affectedRows
    });

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

  const MAX_MINUTES = 14 * 60 + 20;

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

"user_name",
"user_mail",
"department",
"date",
"rotation",

/* WEBSITE AUDIT */
"Website_Audit_Type_Of_Work",
"Website_Audit_Brand",
"Website_Audit_Type_Of_Task",
"Website_Audit_hours",
"Website_Audit_minutes",
"Website_Audit_Remark",
"Website_Audit_Status",

/* SOCIAL MEDIA */
"Social_Media_Audit_Type_Of_Work",
"Social_Media_Audit_Brand",
"Social_Media_Audit_Type_Of_Task",
"Social_Media_Audit_hours",
"Social_Media_Audit_minutes",
"Social_Media_Audit_Remark",
"Social_Media_Audit_Status",

/* STATIONARY */
"Stationary_Type_Of_Work",
"Stationary_Brand",
"Stationary_Project",
"Stationary_Count",
"Stationary_hours",
"Stationary_minutes",
"Stationary_Remark",

/* REAL ESTATE */
"Real_Estate_Type_Of_Work",
"Real_Estate_Brand",
"Real_Estate_Categories",
"Real_Estate_Count",
"Real_Estate_hours",
"Real_Estate_minutes",
"Real_Estate_Remark",

/* INCENT */
"Incent_Type_Of_Work",
"Incent_Brand",
"Incent_Count",
"Incent_Eastat_hours",
"Incent_Eastat_minutes",
"Incent_Remark",

/* ITC */
"ITC_Cigarette_Type_Of_Work",
"ITC_Cigarette_Platform",
"ITC_Cigarette_Count",
"ITC_Cigarette_hours",
"ITC_Cigarette_minutes",
"ITC_Cigarette_Remark",

/* NICOTINE */
"Nicotine_Type_Of_Work",
"Nicotine_Platform",
"Nicotine_Count",
"Nicotine_hours",
"Nicotine_minutes",
"Nicotine_Remark",

/* SHOPEE */
"Shopee_Type_Of_Work",
"Shopee_Platform",
"Shopee_Count",
"Shopee_hours",
"Shopee_minutes",
"Shopee_Remark",

/* POC */
"POC_Type_Of_Work",
"POC_Platform",
"POC_Count",
"POC_hours",
"POC_minutes",
"POC_Remark"

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

  res.json({
    success: true,
    message: "Data submitted successfully",
    remainingHours: Math.floor(remainingMinutes / 60),
    remainingMinutes: remainingMinutes % 60
  });

  sendSubmissionEmail(user_mail, department, date, data);
});
});  // ✅ CLOSE fetchSql query

}); 
/* ======================
   BRAND INFRINGEMENT SUBMIT
====================== */
app.post("/submitBrandInfringement", upload.none(), (req, res) => {

  if (!db) {
    return res.json({
      success:false,
      message:"Database not connected"
    });
  }

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
          .reduce((a,b) => a+b,0);

      } else {

        data[cleanKey] = rawData[key].join(", ");

      }

    } else {

      data[cleanKey] = rawData[key];

    }

  });

 const allowedColumns = [

"user_name",
"user_mail",
"department",
"role",    
"date",
"rotation",

/* LIVE CUSTOMER */
"LiveCustomer_Type_Of_Work",
"LiveCustomer_Brand",
"LiveCustomer_Channel",
"LiveCustomer_Count",
"LiveCustomer_Automation_Checked_Count",
"LiveCustomer_hours",
"LiveCustomer_minutes",
"LiveCustomer_Remark",

/* POC */
"POC_Type_Of_Work",
"POC_Brand",
"POC_Channel",
"POC_Count",
"POC_Automation_Checked_Count",
"POC_hours",
"POC_minutes",
"POC_Remark"

];

  const values = allowedColumns.map(col => {

    if (col.endsWith("_hours") || col.endsWith("_minutes") || col.endsWith("_Count")) {
      return data[col] ? Number(data[col]) : 0;
    }

    return data[col] ? data[col] : "";
  });

  const placeholders = allowedColumns.map(()=>"?").join(",");

  const sql = `
  INSERT INTO brand_infringement
  (${allowedColumns.join(",")})
  VALUES (${placeholders})
  `;

  db.query(sql, values, (err)=>{

    if(err){
      console.error("❌ BI INSERT ERROR:",err.message);
      return res.json({
        success:false,
        message:err.message
      });
    }

    res.json({
      success:true,
      message:"Brand Infringement submitted successfully"
    });

    sendSubmissionEmail(data.user_mail, data.department, data.date, data);

  });

});
/* ======================
   BRAND AFFILIATE SUBMIT
====================== */
app.post("/submitBrandAffiliate", upload.none(), (req, res) => {

  if (!db) {
    return res.json({
      success: false,
      message: "Database not connected",
      remainingHours: 0,
      remainingMinutes: 0
    });
  }

  const rawData = req.body;
  const data = {};

  // 🔥 CLEAN DATA
  Object.keys(rawData).forEach(key => {

    const cleanKey = key
      .replace(/\[\]$/, '')
      .replace(/\s+/g, "_");

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

  // 🔍 DEBUG (optional)
  console.log("FINAL DATA:", data);

  const allowedColumns = [

    "user_name",
    "user_mail",
    "department",
    "date",
    "rotation",

    /* LIVE CUSTOMER */
    "Live_Customer_Type_Of_Work",
    "Live_Customer_Brand",
    "Live_Customer_Count",
    "Live_Customer_Remark",
    "Live_Customer_hours",
    "Live_Customer_minutes",

    /* POC */
    "POC_Type_Of_Work",
    "POC_Brand",
    "POC_Count",
    "POC_Remark",
    "POC_hours",
    "POC_minutes",

    /* R&D */
    "R_D_Type_Of_Work",
    "R_D_Brand",
    "R_D_Count",
    "R_D_Remark",
    "R_D_hours",
    "R_D_minutes"

  ];

  const values = allowedColumns.map(col => {

    if (
      col.endsWith("_hours") ||
      col.endsWith("_minutes") ||
      col.endsWith("_Count")
    ) {
      return Number(data[col]) || 0;
    }

    return data[col] || "";
  });

  const placeholders = allowedColumns.map(() => "?").join(",");

  const sql = `
    INSERT INTO brand_affiliate
    (${allowedColumns.join(",")})
    VALUES (${placeholders})
  `;

  db.query(sql, values, (err) => {

    if (err) {
      console.error("❌ Affiliate Insert Error:", err.message);

      return res.json({
        success: false,
        message: err.message,
        remainingHours: 0,
        remainingMinutes: 0
      });
    }

    // ✅ FINAL SUCCESS RESPONSE (IMPORTANT FIX)
    return res.json({
      success: true,
      message: "Brand Affiliate submitted successfully",
      remainingHours: 0,
      remainingMinutes: 0
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

    sendSubmissionEmail(data.user_mail, data.department, data.date, data);

  });

});

/* ======================
   Anti Money Laundering SUBMIT
====================== */
app.post("/submitAntiMoneyLaundering", upload.none(), (req, res) => {

  if (!db) {
    return res.json({
      success:false,
      message:"Database not connected"
    });
  }

  const data = req.body;

if (
    !data.user_name ||
    !data.user_mail ||
    !data.department ||
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
"date",
"Attendance",   // ✅ ADD THIS

"Daily_Cases",
"Multiple_Cases",
"Not_Found_Cases",
"App",
"Net_Banking_Credit_Card",
"Messaging_Channel_Platform",
"Crypto_cases",
"International_cases",
"Total_Cases",
"Errors",

"Non_video_qc",
"video_qc",
"Total_Qc",
"home_qc",

"Website_Searching",
"Remark_Checking",
"Credential_Making",

"UPI_Fraud",
"investment_web_case",
"investment_sm_case",
"investment_scam_scrap",
"IS_App",
"remark",
"Total_scam_case"
];

/*   "Additional_Information_1",
"Additional_Information_2",
"Additional_Information_3",
"Additional_Information_4",
"Additional_Information_5",
"Additional_Information_6",
"Additional_Information_7",
"Additional_Information_8" */

  const values = allowedColumns.map(col => {

  const val = data[col];

  // 🔥 convert numbers properly
  if (
    col.endsWith("_Cases") ||
    col.endsWith("_qc") ||
    col.endsWith("_Count") ||
    col.includes("Cases") ||
    col.includes("Qc") ||
    col.includes("Fraud") ||
    col.includes("Information")
  ) {
    return val ? Number(val) : 0;
  }

  // 🔥 allow NULL instead of ""
  return val !== undefined ? val : null;

});

  const placeholders = allowedColumns.map(()=>"?").join(",");

  const sql = `
  INSERT INTO anti_money_laundering_data
  (${allowedColumns.join(",")})
  VALUES (${placeholders})
  `;

  db.query(sql, values, (err)=>{

    if(err){
      console.error("❌ BI INSERT ERROR:",err.message);
      return res.json({
        success:false,
        message:err.message
      });
    }

    res.json({
      success: true,
      message: "Anti Money Laundering submitted successfully"
    });

    sendSubmissionEmail(data.user_mail, data.department, data.date, data);

  });

});

/* ======================
   CRON JOB: CHECK DATA FILING DUES & SUMMARIES
====================== */
const executeDuesCheckLogic = (runType = "night", res = null) => {
    if (!db) {
        if (res) return res.status(500).json({ error: "Database not connected" });
        return;
    }

    // Fetch all active employees
    const empSql = `
        SELECT User_Mail, User_Name, Department, Designation, Role 
        FROM mis_user_data 
        WHERE is_archived = 0 
          AND LOWER(Role) != 'admin' 
          AND LOWER(Role) != 'director' 
          AND LOWER(Designation) != 'director'
    `;
    db.query(empSql, (err, employees) => {
        if (err) {
            console.error("Error fetching employees for dues check:", err);
            if (res) return res.status(500).json({ error: "Database error" });
            return;
        }

        const todayStr = new Date().toISOString().split('T')[0];
        const todayDate = new Date(todayStr);

        const promises = employees.map(emp => {
            return new Promise((resolve) => {
                const dept = (emp.Department || "").trim().toLowerCase();
                let table = "";
                if (dept === "brand_infringement") table = "brand_infringement";
                else if (dept === "media_monitoring") table = "media_monitoring_data";
                else if (dept === "social_media_n_website_audit") table = "social_media_n_website_audit_data";
                else if (dept === "anti_money_laundering") table = "anti_money_laundering_data";

                if (!table) {
                    // No table associated with this department, skip dues checking for them
                    return resolve({ ...emp, diffDays: 0, lastDate: null, hasTable: false });
                }

                const sql = `SELECT MAX(date) AS last_date FROM \`${table}\` WHERE user_mail = ?`;
                db.query(sql, [emp.User_Mail], (err, rows) => {
                    if (err || rows.length === 0 || !rows[0].last_date) {
                        // Never filled, default to 5 days ago
                        return resolve({ ...emp, diffDays: 5, lastDate: null, hasTable: true });
                    }
                    const lastDateVal = new Date(rows[0].last_date);
                    const diffTime = todayDate.getTime() - lastDateVal.getTime();
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    resolve({ ...emp, diffDays, lastDate: rows[0].last_date, hasTable: true });
                });
            });
        });

        Promise.all(promises).then(results => {
            // Group by department
            const depts = [...new Set(results.filter(r => r.hasTable).map(r => r.Department))];
            
            // Build summary maps
            const oneDayDueList = [];
            const threeDayDueList = [];
            const filledTodayList = [];

            results.forEach(r => {
                if (!r.hasTable) return;
                
                if (r.diffDays === 0) {
                    filledTodayList.push(r);
                } else if (r.diffDays === 1 || r.diffDays === 2) {
                    oneDayDueList.push(r);
                } else if (r.diffDays >= 3) {
                    threeDayDueList.push(r);
                }
            });

            // Process each department
            const deptPromises = depts.map(dept => {
                return new Promise((resolveDept) => {
                    // Fetch Team Leads, Project Leads, Directors of this department
                    const leadsSql = `
                        SELECT User_Mail, Designation, Role 
                        FROM mis_user_data 
                        WHERE is_archived = 0 
                          AND LOWER(TRIM(Department)) = LOWER(TRIM(?))
                          AND (
                            Designation = 'Project Lead' 
                            OR Designation = 'Team Lead' 
                            OR Role = 'Team_Lead'
                            OR Role = 'Admin' 
                            OR Role = 'Director'
                          )
                    `;
                    db.query(leadsSql, [dept], (err, managers) => {
                        if (err) {
                            console.error(`Error fetching managers for dept ${dept}:`, err);
                            return resolveDept();
                        }

                        const deptResults = results.filter(r => r.Department === dept && r.hasTable);
                        const filled = deptResults.filter(r => r.diffDays === 0);
                        const due1 = deptResults.filter(r => r.diffDays === 1 || r.diffDays === 2);
                        const due3 = deptResults.filter(r => r.diffDays >= 3);

                        // If no one is due and no one filled, skip
                        if (deptResults.length === 0) return resolveDept();

                        // 1. NIGHT RUN: Send summary email to managers
                        const sendDeptEmailPromise = new Promise((resolveSend) => {
                            if (runType === "night" && managers.length > 0) {
                                const managerEmails = cleanEmailRecipients(managers.map(m => m.User_Mail));
                                if (managerEmails.length > 0) {
                                    const formattedDate = todayDate.toLocaleDateString("en-US", {
                                        weekday: 'long',
                                        year: 'numeric',
                                        month: 'long',
                                        day: 'numeric'
                                    });

                                    let due1Rows = due1.map(e => `<li>🔴 <strong>${e.User_Name}</strong> (${e.User_Mail}) - Last filled: ${e.lastDate ? new Date(e.lastDate).toLocaleDateString() : 'Never'}</li>`).join("");
                                    let due3Rows = due3.map(e => `<li>🚨 <strong>${e.User_Name}</strong> (${e.User_Mail}) - Last filled: ${e.lastDate ? new Date(e.lastDate).toLocaleDateString() : 'Never'}</li>`).join("");
                                    let filledRows = filled.map(e => `<li>🟢 <strong>${e.User_Name}</strong> (${e.User_Mail}) - Filled today successfully</li>`).join("");

                                    const deptHtml = `
                                        <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #e2e8f0;">
                                            <h2 style="color: #0f172a; margin: 0 0 15px 0; font-size: 20px; font-weight: 700; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">Filing Status Summary: ${dept}</h2>
                                            <p style="color: #64748b; font-size: 13px;">Daily status report for ${formattedDate}</p>
                                            
                                            <div style="background-color: #ffffff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; margin-bottom: 15px;">
                                                <h3 style="color: #dc2626; font-size: 14px; font-weight: 600; margin: 0 0 10px 0;">🚨 Pending (3+ Days Due)</h3>
                                                <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #475569; line-height: 1.5;">
                                                    ${due3Rows || '<li>None</li>'}
                                                </ul>
                                            </div>
                                            
                                            <div style="background-color: #ffffff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0; margin-bottom: 15px;">
                                                <h3 style="color: #ea580c; font-size: 14px; font-weight: 600; margin: 0 0 10px 0;">🔴 Pending (1-2 Days Due)</h3>
                                                <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #475569; line-height: 1.5;">
                                                    ${due1Rows || '<li>None</li>'}
                                                </ul>
                                            </div>
                                            
                                            <div style="background-color: #ffffff; border-radius: 8px; padding: 15px; border: 1px solid #e2e8f0;">
                                                <h3 style="color: #16a34a; font-size: 14px; font-weight: 600; margin: 0 0 10px 0;">🟢 Completed Today</h3>
                                                <ul style="margin: 0; padding-left: 20px; font-size: 13px; color: #475569; line-height: 1.5;">
                                                    ${filledRows || '<li>None</li>'}
                                                </ul>
                                            </div>
                                        </div>
                                    `;

                                    fetch("https://api.brevo.com/v3/smtp/email", {
                                        method: "POST",
                                        headers: {
                                            "accept": "application/json",
                                            "api-key": process.env.BREVO_API_KEY || "",
                                            "content-type": "application/json"
                                        },
                                        body: JSON.stringify({
                                            sender: { name: "Pixeltruth Scheduler", email: "pixeltruth.notify@gmail.com" },
                                            to: managerEmails.map(email => ({ email })),
                                            cc: [{ email: "jigyasha.pathak@pixeltruth.com", name: "Jigyasha Pathak" }],
                                            subject: `📊 Filing Summary [${dept}]: ${formattedDate}`,
                                            htmlContent: deptHtml
                                        })
                                    }).then(() => {
                                        console.log(`✅ Sent department summary for ${dept} to leads.`);
                                        resolveSend();
                                    }).catch(err => {
                                        console.error(`❌ Failed to send department summary for ${dept}:`, err);
                                        resolveSend();
                                    });
                                } else {
                                    resolveSend();
                                }
                            } else {
                                resolveSend();
                            }
                        });

                        // 2. MORNING/EVENING RUN: Send individual warnings direct to employee with Project Leads CC'd
                        const individualPromises = deptResults.filter(r => r.diffDays >= 1).map(dueEmp => {
                            return new Promise((resolveWarning) => {
                                if (runType !== "morning" && runType !== "evening") {
                                    return resolveWarning();
                                }

                                // Fetch project leads for the department
                                const pLeads = managers.filter(m => m.Designation === 'Project Lead').map(m => m.User_Mail);
                                const rawRecipients = [dueEmp.User_Mail, ...pLeads];
                                const recipients = cleanEmailRecipients(rawRecipients);

                                if (recipients.length === 0) return resolveWarning();

                                const timeLabel = runType === "morning" ? "Morning Reminder (10:00 AM)" : "Evening Reminder (4:00 PM)";

                                const warnHtml = `
                                    <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 550px; margin: 0 auto; padding: 25px; background-color: #fffaf0; border-radius: 12px; border: 1px solid #fbd38d;">
                                        <div style="text-align: center; margin-bottom: 15px;">
                                            <span style="background-color: #feebc8; color: #c05621; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 100px; text-transform: uppercase;">${timeLabel}</span>
                                        </div>
                                        <h2 style="color: #dd6b20; margin: 0 0 10px 0; font-size: 18px; font-weight: 700; text-align: center;">⚠️ Daily Work Log Due Alert</h2>
                                        <p style="color: #4a5568; font-size: 14px; line-height: 1.6;">
                                            Hello <strong>${dueEmp.User_Name}</strong>,<br><br>
                                            This is a reminder that you have not submitted your daily work logs for the last <strong>${dueEmp.diffDays} day(s)</strong>.
                                        </p>
                                        <div style="background: #ffffff; padding: 15px; border-radius: 8px; border: 1px solid #e2e8f0; margin-top: 15px; font-size: 13px;">
                                            <strong>Last submission:</strong> ${dueEmp.lastDate ? new Date(dueEmp.lastDate).toLocaleDateString() : 'Never'}<br>
                                            <strong>Department:</strong> ${dueEmp.Department}
                                        </div>
                                        <p style="color: #718096; font-size: 12px; margin-top: 20px; text-align: center; font-style: italic;">
                                            Please make sure to fill your daily logs as soon as possible to keep your attendance and records up to date.
                                        </p>
                                    </div>
                                `;

                                fetch("https://api.brevo.com/v3/smtp/email", {
                                    method: "POST",
                                    headers: {
                                        "accept": "application/json",
                                        "api-key": process.env.BREVO_API_KEY || "",
                                        "content-type": "application/json"
                                    },
                                    body: JSON.stringify({
                                        sender: { name: "Pixeltruth Scheduler", email: "pixeltruth.notify@gmail.com" },
                                        to: recipients.map(email => ({ email })),
                                        cc: [{ email: "jigyasha.pathak@pixeltruth.com", name: "Jigyasha Pathak" }],
                                        subject: `⚠️ Reminder: Daily Work Log Due - ${dueEmp.User_Name}`,
                                        htmlContent: warnHtml
                                    })
                                }).then(() => {
                                    console.log(`✅ Sent individual warning to employee: ${dueEmp.User_Mail} and Project Leads.`);
                                    resolveWarning();
                                }).catch(err => {
                                    console.error(`❌ Failed to send individual due warning to ${recipients}:`, err);
                                    resolveWarning();
                                });
                            });
                        });

                        Promise.all([sendDeptEmailPromise, ...individualPromises]).then(() => {
                            resolveDept();
                        });
                    });
                });
            });

            Promise.all(deptPromises).then(() => {
                // 3. NIGHT RUN: Send global daily summary report to Directors and global Admins
                if (runType !== "night") {
                    if (res) return res.json({ success: true, message: `${runType} notifications sent successfully.` });
                    return;
                }

                const globalSql = `SELECT User_Mail FROM mis_user_data WHERE is_archived = 0 AND (Role = 'Director' OR Role = 'Admin')`;
                db.query(globalSql, (err, directors) => {
                    if (err || directors.length === 0) {
                        if (res) return res.json({ success: true, message: "Summary sent to leads and individuals." });
                        return;
                    }

                    const directorEmails = cleanEmailRecipients(directors.map(d => d.User_Mail));
                    if (directorEmails.length > 0) {
                        const formattedDate = todayDate.toLocaleDateString("en-US", {
                            weekday: 'long',
                            year: 'numeric',
                            month: 'long',
                            day: 'numeric'
                        });

                        const totalEmployees = results.filter(r => r.hasTable).length;
                        const filledToday = filledTodayList.length;
                        const pending1 = oneDayDueList.length;
                        const pending3 = threeDayDueList.length;

                        const globalHtml = `
                            <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 650px; margin: 0 auto; padding: 30px; background-color: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0;">
                                <div style="text-align: center; margin-bottom: 25px;">
                                    <span style="background-color: #e0f2fe; color: #0369a1; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 100px; text-transform: uppercase;">Executive Report</span>
                                    <h2 style="color: #0f172a; margin: 10px 0 0 0; font-size: 22px; font-weight: 700;">Global Daily Filing Summary</h2>
                                    <p style="color: #64748b; font-size: 14px; margin-top: 6px;">Status of all departments on ${formattedDate}</p>
                                </div>
                                
                                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 25px; content-visibility: auto;">
                                    <div style="background: #ffffff; padding: 15px; border-radius: 10px; border: 1px solid #e2e8f0; text-align: center;">
                                        <div style="font-size: 22px; font-weight: 700; color: #0f172a;">${totalEmployees}</div>
                                        <div style="font-size: 11px; color: #64748b; margin-top: 4px; font-weight: 500;">Total Staff</div>
                                    </div>
                                    <div style="background: #ecfdf5; padding: 15px; border-radius: 10px; border: 1px solid #a7f3d0; text-align: center;">
                                        <div style="font-size: 22px; font-weight: 700; color: #047857;">${filledToday}</div>
                                        <div style="font-size: 11px; color: #065f46; margin-top: 4px; font-weight: 500;">Filled Today</div>
                                    </div>
                                    <div style="background: #fff7ed; padding: 15px; border-radius: 10px; border: 1px solid #fed7aa; text-align: center;">
                                        <div style="font-size: 22px; font-weight: 700; color: #c2410c;">${pending1}</div>
                                        <div style="font-size: 11px; color: #9a3412; margin-top: 4px; font-weight: 500;">1-2 Days Due</div>
                                    </div>
                                    <div style="background: #fef2f2; padding: 15px; border-radius: 10px; border: 1px solid #fecaca; text-align: center;">
                                        <div style="font-size: 22px; font-weight: 700; color: #dc2626;">${pending3}</div>
                                        <div style="font-size: 11px; color: #991b1b; margin-top: 4px; font-weight: 500;">3+ Days Due</div>
                                    </div>
                                </div>
                                
                                <div style="background-color: #ffffff; border-radius: 12px; padding: 25px; border: 1px solid #e2e8f0;">
                                    <h3 style="margin-top: 0; color: #1e293b; font-size: 15px; border-bottom: 1px solid #f1f5f9; padding-bottom: 10px; font-weight: 600;">Department Breakdown</h3>
                                    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                                        <thead>
                                            <tr style="border-bottom: 2px solid #e2e8f0; color: #475569; font-weight: 600;">
                                                <th style="padding: 8px 0; text-align: left;">Department</th>
                                                <th style="padding: 8px 0; text-align: center;">Filled Today</th>
                                                <th style="padding: 8px 0; text-align: center;">1-2 Days Due</th>
                                                <th style="padding: 8px 0; text-align: center;">3+ Days Due</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            ${depts.map(d => {
                                                const dResults = results.filter(r => r.Department === d && r.hasTable);
                                                const f = dResults.filter(r => r.diffDays === 0).length;
                                                const d1 = dResults.filter(r => r.diffDays === 1 || r.diffDays === 2).length;
                                                const d3 = dResults.filter(r => r.diffDays >= 3).length;
                                                return `
                                                    <tr style="border-bottom: 1px solid #f1f5f9;">
                                                        <td style="padding: 10px 0; font-weight: 600; color: #0f172a;">${d}</td>
                                                        <td style="padding: 10px 0; text-align: center; color: #16a34a; font-weight: 600;">${f}</td>
                                                        <td style="padding: 10px 0; text-align: center; color: #ea580c; font-weight: 600;">${d1}</td>
                                                        <td style="padding: 10px 0; text-align: center; color: #dc2626; font-weight: 600;">${d3}</td>
                                                    </tr>
                                                `;
                                            }).join("")}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        `;

                        fetch("https://api.brevo.com/v3/smtp/email", {
                            method: "POST",
                            headers: {
                                "accept": "application/json",
                                "api-key": process.env.BREVO_API_KEY || "",
                                "content-type": "application/json"
                            },
                            body: JSON.stringify({
                                sender: { name: "Pixeltruth Scheduler", email: "pixeltruth.notify@gmail.com" },
                                to: directorEmails.map(email => ({ email })),
                                cc: [{ email: "jigyasha.pathak@pixeltruth.com", name: "Jigyasha Pathak" }],
                                subject: `👑 Executive Summary: Daily Filing Report - ${formattedDate}`,
                                htmlContent: globalHtml
                            })
                        }).then(() => {
                            console.log("✅ Sent global summary to Directors.");
                            if (res) res.json({ success: true, message: "Summary sent to leads, individuals, and directors successfully." });
                        }).catch(err => {
                            console.error("❌ Failed to send global summary to Directors:", err);
                            if (res) res.json({ success: true, message: "Summary sent to leads and individuals." });
                        });
                    } else {
                        if (res) res.json({ success: true, message: "Summary sent to leads and individuals." });
                    }
                });
            });
        });
    });
};

const runDuesCheckIfNeeded = () => {
    if (!db) return;
    
    // Get date and hour in India Standard Time (IST)
    const todayStrIST = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(new Date());
    const [m, d, y] = todayStrIST.split('/');
    const todayStr = `${y}-${m}-${d}`;

    const currentHour = parseInt(new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        hour12: false
    }).format(new Date()));

    // Check last runs in database
    db.query("SELECT run_type, last_run_date FROM mis_cron_status ORDER BY id DESC LIMIT 50", (err, rows) => {
        if (err) return;

        const hasRunToday = (type) => rows.some(r => r.run_type === type && r.last_run_date === todayStr);
        const lastRunDateOfType = (type) => {
            const match = rows.find(r => r.run_type === type);
            return match ? match.last_run_date : "";
        };

        // Determine yesterday's date in IST
        const todayDate = new Date(`${todayStr}T00:00:00`);
        const yesterday = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayStrIST = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }).format(yesterday);
        const [ym, yd, yy] = yesterdayStrIST.split('/');
        const yesterdayStr = `${yy}-${ym}-${yd}`;

        // 1. NIGHT RUN (Filing status summaries & global executive report):
        // Run if:
        // - Hour is >= 18 (6:00 PM IST) AND not run today yet.
        // - OR: today is a new day, we haven't run today's night summary yet, AND yesterday's night summary was MISSED (i.e. last night run is older than yesterday).
        const lastNightRun = lastRunDateOfType("night");
        const missedYesterdayNightSummary = lastNightRun !== "" && lastNightRun !== todayStr && lastNightRun !== yesterdayStr;

        if ((currentHour >= 18 && !hasRunToday("night")) || (missedYesterdayNightSummary && !hasRunToday("night"))) {
            db.query("INSERT INTO mis_cron_status (last_run_date, run_type) VALUES (?, 'night')", [todayStr], (err) => {
                if (!err) {
                    console.log("⏰ Auto-Cron: Triggering night summary run...");
                    executeDuesCheckLogic("night");
                }
            });
            return;
        }

        // 2. EVENING RUN (Warnings CC'd to Project Lead): Run if hour is >= 16 (4:00 PM IST) and not run today yet
        if (currentHour >= 16 && !hasRunToday("evening")) {
            db.query("INSERT INTO mis_cron_status (last_run_date, run_type) VALUES (?, 'evening')", [todayStr], (err) => {
                if (!err) {
                    console.log("⏰ Auto-Cron: Triggering evening warning run...");
                    executeDuesCheckLogic("evening");
                }
            });
            return;
        }

        // 3. MORNING RUN (Warnings CC'd to Project Lead): Run if hour is >= 10 (10:00 AM IST) and not run today yet
        if (currentHour >= 10 && !hasRunToday("morning")) {
            db.query("INSERT INTO mis_cron_status (last_run_date, run_type) VALUES (?, 'morning')", [todayStr], (err) => {
                if (!err) {
                    console.log("⏰ Auto-Cron: Triggering morning warning run...");
                    executeDuesCheckLogic("morning");
                }
            });
            return;
        }
    });
};

app.get("/api/cron/check-dues", (req, res) => {
    const runType = req.query.runType || "night";
    executeDuesCheckLogic(runType, res);
});

/* ======================
   COMMON DASHBOARD (ALL DEPARTMENTS)
====================== */
app.get("/getDepartmentData", (req, res) => {
  runDuesCheckIfNeeded();

  if (!db) return res.json([]);

  const { user_mail, role, department } = req.query;

  if (!user_mail || !role || !department) {
    return res.json([]);
  }

const roles = role.split(",").map(r => r.trim().toUpperCase().replace(/\s+/g, "_"));
  const dept = department.trim().toLowerCase();
  const userMail = user_mail.trim();

  let tableName = "";

  if (dept === "social_media_n_website_audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (dept === "media_monitoring") {
    tableName = "media_monitoring_data";
  }
  else if (dept === "brand_infringement") {
    tableName = "brand_infringement";
  }
  else if (dept === "anti_money_laundering") {
    tableName = "anti_money_laundering_data";
  }
else if (dept === "brand_safety_affiliate" || dept === "brand_affiliate") {
  tableName = "brand_affiliate";
}
  else {
    return res.json([]);
  }

  let sql = "";
  let params = [];

let orderByColumn = "insert_id";

if (
  tableName === "brand_infringement" ||
  tableName === "brand_affiliate"
) {
  orderByColumn = "id";
}


// Director / HR Manager / Admin / HR / Team Lead
if (
  roles.includes("DIRECTOR") ||
  roles.includes("HR_MANAGER") ||
  roles.includes("ADMIN") ||
  roles.includes("HR") ||
  roles.includes("TEAM_LEAD")
) {

  sql = `
    SELECT t.*
    FROM ${tableName} t
    INNER JOIN mis_user_data u
      ON LOWER(TRIM(t.user_mail)) = LOWER(TRIM(u.User_Mail))
    WHERE u.is_archived = 0
    ORDER BY t.date DESC, t.${orderByColumn} DESC
  `;

}

// Employee / Intern
else {

  sql = `
    SELECT t.*
    FROM ${tableName} t
    INNER JOIN mis_user_data u
      ON LOWER(TRIM(t.user_mail)) = LOWER(TRIM(u.User_Mail))
    WHERE
      LOWER(TRIM(t.user_mail)) = LOWER(?)
      AND u.is_archived = 0
    ORDER BY t.date DESC, t.${orderByColumn} DESC
  `;

  params = [userMail];
}
  db.query(sql, params, (err, rows) => {

    if (err) {
      console.error("❌ Dashboard Query Error:", err.message);
      return res.json([]);
    }

    console.log("AML DATA COUNT:", rows.length);

    res.json(rows);

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

/* ======================
   COMMON APPROVAL UPDATE (ALL DEPARTMENTS)
====================== */
app.post("/updateApprovalStatus", (req, res) => {

  if (!db) return res.json({ success:false });

  const { id, status, department } = req.body;

  if (!id || !status || !department) {
    return res.json({ success:false });
  }

  let tableName = "";
  let idColumn = "insert_id";   // default

  if (department === "Media_Monitoring") {
    tableName = "media_monitoring_data";
    idColumn = "insert_id";
  }
  else if (department === "Social_Media_N_Website_Audit") {
    tableName = "social_media_n_website_audit_data";
    idColumn = "insert_id";
  }
  else if (department === "Brand_Infringement") {
    tableName = "brand_infringement";
    idColumn = "id";
  }
   else if (department === "Anti_Money_Laundering") {
  tableName = "anti_money_laundering_data";
  idColumn = "insert_id";
}
  else {
    return res.json({ success:false });
  }

  const sql = `
    UPDATE ${tableName}
    SET approval_status = ?
    WHERE ${idColumn} = ?
  `;

  db.query(sql, [status, id], (err) => {

    if (err) {
      console.error("Approval update error:", err.message);
      return res.json({ success:false });
    }

    res.json({
      success:true,
      message:"Status updated"
    });

  });

});
/* ======================
   COMMON Task Assigment
====================== */
app.get("/getUsersByDepartment", (req, res) => {
  if (!db) return res.json([]);

  const { department } = req.query;
  if (!department) return res.json([]);

  const dept = department.trim();

const sql = `
  SELECT DISTINCT
    u.User_Name,
    u.User_Mail
  FROM mis_user_data u
  LEFT JOIN user_departments d
    ON u.User_Mail = d.user_mail
  WHERE u.is_archived = 0

    -- 🔥 MULTI ROLE SAFE FILTER
    AND u.Role NOT LIKE '%HR%'
    AND u.Role NOT LIKE '%Admin%'
    AND u.Role NOT LIKE '%Director%'
    AND u.Role NOT LIKE '%HR Manager%'

    -- 🔥 DEPARTMENT MATCH
    AND (
      LOWER(TRIM(u.Department)) = LOWER(?)
      OR LOWER(TRIM(d.department)) = LOWER(?)
    )
`;

  db.query(sql, [dept, dept], (err, rows) => {
    if (err) {
      console.error("❌ getUsersByDepartment error:", err.message);
      return res.json([]);
    }

    console.log("Users found:", rows.length);
    res.json(rows);
  });
});

/* ======================
   GET USERS IN DEPARTMENT (ALIAS)
====================== */
app.get("/getUsersInDepartment", (req, res) => {

  if (!db) return res.json([]);

  const { department } = req.query;

  if (!department) return res.json([]);

  const sql = `
    SELECT User_Name, User_Mail, Department
    FROM mis_user_data
    WHERE LOWER(TRIM(Department)) = LOWER(?)
      AND is_archived = 0
  `;

  db.query(sql, [department.trim()], (err, rows) => {
    if (err) return res.json([]);
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
    Estate_hours,
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
      Estate_hours,
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
      Estate_hours || 0,
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
    Estate_hours,
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
      Estate_hours = ?
    WHERE id = ?
  `;

  const values = [
    user_name,
    user_mail,
    task_title,
    task_description || "",
    due_date,
    Estate_hours || 0,
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
   SMART BULK UPLOAD (AUTO TABLE SELECT)
====================== */

app.post("/bulkUpload", upload.single("file"), (req, res) => {

  if (!db) {
    return res.json({ success:false, message:"DB not connected" });
  }

  if (!req.file) {
    return res.json({ success:false, message:"No file uploaded" });
  }

  const csv = require("csv-parser");
  const stream = require("stream");

  const results = [];
  const bufferStream = new stream.PassThrough();
  bufferStream.end(req.file.buffer);

  bufferStream
    .pipe(csv())
    .on("data", (data) => {
      results.push(data);
    })
    .on("end", () => {

      if (!results.length) {
        return res.json({ success:false, message:"Empty file" });
      }

      let processed = 0;
      let hasError = false;

      results.forEach(row => {
         console.log("CSV ROW:", row);
if (row.date && row.date.includes("/")) {
  const parts = row.date.split("/");
  row.date = `${parts[2]}-${parts[1]}-${parts[0]}`;
}
        const department = (row.department || "").trim();

        if (!department) {
          hasError = true;
          processed++;
          return;
        }

        /* ======================
           AUTO TABLE MAPPING
        ======================= */

        let tableName = "";

        if (department.toLowerCase() === "social_media_n_website_audit") {
  tableName = "social_media_n_website_audit_data";
}
else if (department.toLowerCase() === "media_monitoring") {
  tableName = "media_monitoring_data";
}
else if (department.toLowerCase() === "brand_infringement") {
  tableName = "brand_infringement";
}
else if (department.toLowerCase() === "anti_money_laundering") {
  tableName = "anti_money_laundering_data";
}
         if (!tableName) {
  hasError = true;
  processed++;
  return;
}

const columns = Object.keys(row)
  .filter(col => col && col.trim() !== "");

const values = columns.map(col => row[col]);

        const insertSql = `
          INSERT INTO ${tableName}
          (${columns.join(",")})
          VALUES (${columns.map(() => "?").join(",")})
        `;

        db.query(insertSql, values, (err) => {

          if (err) {
            console.error("❌ Bulk insert error:", err.message);
            hasError = true;
          }

          processed++;

          if (processed === results.length) {
            if (hasError) {
              return res.json({
                success:false,
                message:"Some rows failed"
              });
            }

            return res.json({
              success:true,
              message:`${results.length} rows uploaded successfully`
            });
          }

        });

      });

    });

});
/* ======================
   DELETE DEPARTMENT DATA
====================== */
app.post("/deleteDepartmentData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id, department } = req.body;

  if (!id || !department) {
    return res.json({ success: false });
  }

  const dept = department.toLowerCase();

  let tableName = "";
  let idColumn = "insert_id";

  if (dept === "social_media_n_website_audit") {
    tableName = "social_media_n_website_audit_data";
    idColumn = "insert_id";
  }
  else if (dept === "media_monitoring") {
    tableName = "media_monitoring_data";
    idColumn = "insert_id";
  }
  else if (dept === "brand_infringement") {
    tableName = "brand_infringement";
    idColumn = "id";
  }
else if (dept === "brand_affiliate" || dept === "brand_safety_affiliate") {
  tableName = "brand_affiliate";
  idColumn = "id";
}
else if (dept === "anti_money_laundering") {
  tableName = "anti_money_laundering_data";
  idColumn = "insert_id";
}
  else {
    return res.json({ success: false });
  }

  const sql = `
    DELETE FROM ${tableName}
    WHERE ${idColumn} = ?
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
   UPDATE DEPARTMENT DATA (FINAL FIXED)
====================== */
app.post("/updateDepartmentData", (req, res) => {

  if (!db) return res.json({ success: false });

  const { id, column, value, department } = req.body;

  console.log("UPDATE HIT:", { id, column, value, department });

  if (!id || !column || !department) {
    return res.json({ success: false, message: "Missing data" });
  }

  const dept = department.toLowerCase().trim();

  let tableName = "";
  let idColumn = "insert_id";

  /* ======================
     TABLE MAPPING
  ====================== */

  if (dept === "social_media_n_website_audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (dept === "media_monitoring") {
    tableName = "media_monitoring_data";
  }
  else if (dept === "brand_infringement") {
    tableName = "brand_infringement";
    idColumn = "id";
  }
else if (dept === "brand_affiliate" || dept === "brand_safety_affiliate") {
  tableName = "brand_affiliate";
  idColumn = "id";
}
  else if (dept === "anti_money_laundering") {
    tableName = "anti_money_laundering_data";
  }
  else {
    return res.json({ success: false, message: "Invalid department" });
  }

  /* ======================
     🔥 SAFE COLUMN CHECK (DB BASED)
  ====================== */

  const checkColumnSql = `
    SELECT COLUMN_NAME 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_NAME = ?
  `;

  db.query(checkColumnSql, [tableName], (err, columns) => {

    if (err) {
      console.error("❌ Column check error:", err.message);
      return res.json({ success: false });
    }

    const columnList = columns.map(c => c.COLUMN_NAME);

    if (!columnList.includes(column)) {
      return res.json({
        success: false,
        message: "Invalid column"
      });
    }

    /* ======================
       UPDATE QUERY
    ====================== */

    const sql = `
      UPDATE ${tableName}
      SET ${column} = ?
      WHERE ${idColumn} = ?
    `;

    db.query(sql, [value, id], (err) => {

      if (err) {
        console.error("❌ UPDATE ERROR:", err.message);
        return res.json({ success: false, message: err.message });
      }

      console.log("✅ UPDATED SUCCESS");

      res.json({ success: true });

    });

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
      Estate_hours,
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
      AND Role NOT LIKE '%HR%'
AND Role NOT LIKE '%Admin%'
AND Role NOT LIKE '%Team_Lead%'
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
      Estate_hours,
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
   SUPER ADMIN DASHBOARD DATA
====================== */
/* ======================
   SUPER ADMIN DASHBOARD (ALL DEPARTMENTS – MULTI TABLE)
====================== */
app.get("/getSuperAdminDashboardData", (req, res) => {

  if (!db) return res.json({ success:false });

  const today = new Date().toISOString().split("T")[0];

  /* ===============================
     STEP 1 – GET ALL ACTIVE USERS
  =============================== */

  const usersQuery = `
    SELECT User_Mail, Department
    FROM mis_user_data
    WHERE is_archived = 0
      AND Role NOT LIKE '%HR%'
AND Role NOT LIKE '%Admin%'
AND Role NOT LIKE '%Team_Lead%'
AND Role NOT LIKE '%Director%'
AND Role NOT LIKE '%HR Manager%'
  `;

  db.query(usersQuery, (err, users) => {

    if (err) {
      console.error("❌ Users Query Error:", err.message);
      return res.json({ success:false });
    }

    if (!users.length) {
      return res.json({ success:true, summary:{}, departments:[] });
    }

    /* ===============================
       STEP 2 – GET TODAY SUBMISSIONS
       FROM ALL TABLES USING UNION
    =============================== */

const submissionQuery = `
  SELECT DISTINCT user_mail FROM social_media_n_website_audit_data
  WHERE DATE(date) = ?

  UNION

  SELECT DISTINCT user_mail FROM media_monitoring_data
  WHERE DATE(date) = ?

  UNION

  SELECT DISTINCT user_mail FROM brand_infringement
  WHERE DATE(date) = ?

UNION
SELECT DISTINCT user_mail FROM brand_affiliate WHERE DATE(date)=?
  UNION

  SELECT DISTINCT user_mail FROM anti_money_laundering_data
  WHERE DATE(date) = ?
`;

    db.query(
  submissionQuery,
  [today, today, today, today, today],
  (err, submissions) => {

      if (err) {
        console.error("❌ Submission Query Error:", err.message);
        return res.json({ success:false });
      }

      /* ===============================
         STEP 3 – GET INACTIVE (3 DAYS)
      =============================== */
const inactiveQuery = `
  SELECT COUNT(*) AS inactiveUsers
  FROM mis_user_data u
  WHERE u.is_archived = 0
    AND u.Role NOT IN ('HR','Admin','Team_Lead','Director','HR Manager')
    AND NOT EXISTS (
      SELECT 1 FROM social_media_n_website_audit_data s
        WHERE s.user_mail = u.User_Mail
        AND DATE(s.date) >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)

      UNION

      SELECT 1 FROM media_monitoring_data m
        WHERE m.user_mail = u.User_Mail
        AND DATE(m.date) >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)

      UNION

      UNION

SELECT 1 FROM brand_infringement b
  WHERE b.user_mail = u.User_Mail
  AND DATE(b.date) >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)

UNION

SELECT 1 FROM brand_affiliate ba
  WHERE ba.user_mail = u.User_Mail
  AND DATE(ba.date) >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)

UNION

SELECT 1 FROM anti_money_laundering_data a
  WHERE a.user_mail = u.User_Mail
  AND DATE(a.date) >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
    )
`;

      db.query(inactiveQuery, (err, inactiveRows) => {

        if (err) {
          console.error("❌ Inactive Query Error:", err.message);
          return res.json({ success:false });
        }

        /* ===============================
           STEP 4 – PROCESS DATA
        =============================== */

        const submittedSet = new Set(
          submissions.map(s => s.user_mail)
        );

         console.log("TODAY:", today);
console.log("USERS:", users);
console.log("SUBMISSIONS:", submissions);
console.log("INACTIVE:", inactiveRows);
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

        const departments = Object.values(departmentMap).map(d => ({
          ...d,
          missing: d.totalEmployees - d.submittedToday
        }));

        const totalDepartments = departments.length;
        const totalEmployees = users.length;
        const totalSubmittedToday = submissions.length;

        res.json({
          success:true,
          summary:{
            totalDepartments,
            totalEmployees,
            totalSubmittedToday,
            inactiveUsers: inactiveRows[0].inactiveUsers
          },
          departments
        });

      });

    });

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
     🔥 NORMALIZE DEPARTMENT
  ========================== */

  const dept = department.trim();

  let tableName = "";

  if (dept === "Social_Media_N_Website_Audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (dept === "Brand_Infringement") {
    tableName = "brand_infringement";
  }
  else if (dept === "Media_Monitoring") {
    tableName = "media_monitoring_data";
  }
  else if (dept === "Anti_Money_Laundering") {
    tableName = "anti_money_laundering_data";
  }
  else {
    return res.json({ success:false, message:"Invalid department" });
  }

  /* ==========================
     🔥 MAIN QUERY (FIXED)
     ❌ removed department filter
  ========================== */

  let sql = `SELECT * FROM ${tableName}`;
  let params = [];

  /* ==============================
     DATE RANGE / TYPE FILTER
  ============================== */

  if (from && to) {

    sql += " WHERE DATE(date) BETWEEN ? AND ?";
    params.push(from, to);

  } 
  else if (type) {

    sql += " WHERE ";

    if (type === "day") {
      sql += "DATE(date) = CURDATE()";
    }
    else if (type === "week") {
      sql += "YEARWEEK(date, 1) = YEARWEEK(CURDATE(), 1)";
    }
    else if (type === "month") {
      sql += "MONTH(date) = MONTH(CURDATE()) AND YEAR(date) = YEAR(CURDATE())";
    }
    else {
      return res.json({ success:false, message:"Invalid type" });
    }

  }

  /* ==========================
     🔥 ORDER BY FIX
  ========================== */

  let orderColumn = "insert_id";

  if (tableName === "brand_infringement") {
    orderColumn = "id";
  }

  sql += ` ORDER BY date DESC, ${orderColumn} DESC`;

  /* ==========================
     🔥 EXECUTE QUERY
  ========================== */

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

        // ✅ Media Monitoring style
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
   EMPLOYEE WORK SUMMARY
====================== */
app.get("/getEmployeeWorkSummary", (req, res) => {

  if (!db) return res.json([]);

  const { employee, from_date, to_date } = req.query;

  let sql = `
    SELECT
      work_date,
      user_name,
      department,
      SUM(actual_hours) AS hours
    FROM all_tasks_view
    WHERE actual_hours > 0
  `;

  let params = [];

  /* employee filter */
  if (employee) {
    sql += " AND user_name LIKE ?";
    params.push(`%${employee}%`);
  }

  /* date filter */
  if (from_date && to_date) {
    sql += " AND work_date BETWEEN ? AND ?";
    params.push(from_date, to_date);
  }

  sql += `
    GROUP BY work_date, user_name, department
    ORDER BY work_date DESC
  `;

  db.query(sql, params, (err, rows) => {

    if (err) {
      console.error("❌ Work summary error:", err.message);
      return res.json([]);
    }

    res.json(rows);

  });

});

/* ======================
   USER PRODUCTIVITY SUMMARY (ALL DEPARTMENTS)
====================== */

app.get("/getUserSummary", (req, res) => {

  if (!db) {
    return res.json({ success:false });
  }

  const { user_mail, department, month, year } = req.query;

  if (!user_mail || !department || !month || !year) {
    return res.json({ success:false });
  }

  const dept = department.toLowerCase().trim();

  let tableName = "";

  if (dept === "social_media_n_website_audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (dept === "media_monitoring") {
    tableName = "media_monitoring_data";
  }
  else if (dept === "brand_infringement") {
    tableName = "brand_infringement";
  }
  else if (dept === "anti_money_laundering") {
    tableName = "anti_money_laundering_data";
  }
  else {
    return res.json({ success:false });
  }

  const sql = `
    SELECT *
    FROM ${tableName}
    WHERE user_mail = ?
      AND MONTH(date) = ?
      AND YEAR(date) = ?
    ORDER BY date ASC
  `;

  db.query(sql, [user_mail, month, year], (err, rows) => {

    if (err) {
      console.error("❌ Summary Query Error:", err.message);
      return res.json({ success:false });
    }

    let totalMinutes = 0;

    rows.forEach(row => {

      Object.keys(row).forEach(key => {

        if (key.endsWith("_hours")) {
          totalMinutes += Number(row[key] || 0) * 60;
        }

        if (key.endsWith("_minutes")) {
          totalMinutes += Number(row[key] || 0);
        }

        if (key === "hours") {
          totalMinutes += Number(row[key] || 0) * 60;
        }

        if (key === "minutes") {
          totalMinutes += Number(row[key] || 0);
        }

      });

    });

    const daysInMonth = new Date(year, month, 0).getDate();

    const uniqueDates = new Set(
      rows.map(r => new Date(r.date).toISOString().split("T")[0])
    );

    const totalDaysFilled = uniqueDates.size;

    const missedDays = daysInMonth - totalDaysFilled;

    const formattedData = rows.map(r => {

      let minutes = 0;

      Object.keys(r).forEach(k => {

        if (k.endsWith("_hours")) {
          minutes += Number(r[k] || 0) * 60;
        }

        if (k.endsWith("_minutes")) {
          minutes += Number(r[k] || 0);
        }

        if (k === "hours") {
          minutes += Number(r[k] || 0) * 60;
        }

        if (k === "minutes") {
          minutes += Number(r[k] || 0);
        }

      });

      return {
        date: new Date(r.date).toISOString().split("T")[0],
        hours: Math.round(minutes / 60)
      };

    });

    res.json({
      success:true,
      daysInMonth,
      totalDaysFilled,
      missedDays,
      data: formattedData
    });

  });

});

/* ======================
   SUPER ADMIN FULL RAW DATA (ALL TABLES)
====================== */

app.get("/getSuperAdminRawData", (req, res) => {

  if (!db) return res.json([]);

  const { department } = req.query;

  let queries = [];

  // 🔥 All tables
  const tables = [
    "social_media_n_website_audit_data",
    "media_monitoring_data",
    "brand_infringement",
    "anti_money_laundering_data"
  ];

  tables.forEach(table => {

    let q = `SELECT user_name, user_mail, department, date FROM ${table}`;

    if (department && department !== "ALL") {
      q += ` WHERE department = '${department}'`;
    }

    queries.push(q);

  });

  const finalQuery = queries.join(" UNION ALL ");

  db.query(finalQuery, (err, rows) => {

    if (err) {
      console.error("❌ RAW DATA ERROR:", err.message);
      return res.json([]);
    }

    // ✅ Normalize date
    rows.forEach(r => {
      if (r.date) {
        r.date = new Date(r.date).toISOString().split("T")[0];
      }
    });

    res.json(rows);

  });

});
app.get("/getMissedDays", (req, res) => {

  if (!db) return res.json({ success:false });

  const { department, from, to } = req.query;

  if (!from || !to) {
    return res.json({ success:false, message:"Missing params" });
  }

  /* =========================
     🔥 SUPER ADMIN MODE
  ========================= */

  const isAll = !department || department === "ALL";

  /* =========================
     🔥 DATA QUERY (ALL TABLES)
  ========================= */

  let dataSql = "";
  let params = [];

  if (isAll) {

    dataSql = `
      SELECT user_name, user_mail, date FROM social_media_n_website_audit_data
      WHERE DATE(date) BETWEEN ? AND ?

      UNION ALL

      SELECT user_name, user_mail, date FROM media_monitoring_data
      WHERE DATE(date) BETWEEN ? AND ?

      UNION ALL

      SELECT user_name, user_mail, date FROM brand_infringement
      WHERE DATE(date) BETWEEN ? AND ?

      UNION ALL

      SELECT user_name, user_mail, date FROM anti_money_laundering_data
      WHERE DATE(date) BETWEEN ? AND ?
    `;

    params = [from,to, from,to, from,to, from,to];

  } else {

    let tableName = "";

    if (department === "Social_Media_N_Website_Audit") {
      tableName = "social_media_n_website_audit_data";
    }
    else if (department === "Media_Monitoring") {
      tableName = "media_monitoring_data";
    }
    else if (department === "Brand_Infringement") {
      tableName = "brand_infringement";
    }
    else if (department === "Anti_Money_Laundering") {
      tableName = "anti_money_laundering_data";
    }
    else {
      return res.json({ success:false, message:"Invalid department" });
    }

    dataSql = `
      SELECT user_name, user_mail,
      DATE(COALESCE(date, created_at)) as date
      FROM ${tableName}
      WHERE LOWER(TRIM(department)) = LOWER(?)
        AND DATE(COALESCE(date, created_at)) BETWEEN ? AND ?
    `;

    params = [department, from, to];
  }

  db.query(dataSql, params, (err, rows) => {

    if (err) {
      console.error(err);
      return res.json({ success:false });
    }

    /* =========================
       🔥 USERS LIST
    ========================= */

    let userSql = `
      SELECT User_Name, User_Mail
      FROM mis_user_data
      WHERE is_archived = 0
        AND Role NOT LIKE '%HR%'
        AND Role NOT LIKE '%Admin%'
        AND Role NOT LIKE '%Team_Lead%'
        AND Role NOT LIKE '%Director%'
        AND Role NOT LIKE '%HR Manager%'
    `;

    let userParams = [];

    if (!isAll) {
      userSql += " AND LOWER(TRIM(Department)) = LOWER(?)";
      userParams.push(department);
    }

    db.query(userSql, userParams, (err2, users) => {

      if (err2) return res.json({ success:false });

      /* =========================
         🔥 FILLED MAP
      ========================= */

      const mapDates = {};

      rows.forEach(r => {

        const mail = r.user_mail.toLowerCase();
        const date = new Date(r.date).toISOString().split("T")[0];

        if (!mapDates[mail]) mapDates[mail] = new Set();
        mapDates[mail].add(date);

      });

      const start = new Date(from);
      const end = new Date(to);

      /* =========================
         🔥 FINAL RESULT (SAME UI LOGIC)
      ========================= */

      const result = users.map(u => {

        const mail = u.User_Mail.toLowerCase();
        const filledDates = mapDates[mail] || new Set();

        const missedDates = [];

        for (let d = new Date(start); d <= end; d.setDate(d.getDate()+1)) {

          const dateStr = d.toISOString().split("T")[0];

          if (!filledDates.has(dateStr)) {
            missedDates.push(dateStr);
          }

        }

        return {
          user_name: u.User_Name,
          user_mail: u.User_Mail,
          filled_days: filledDates.size,
          missed_days: missedDates.length,
          missed_dates: missedDates
        };

      });

      res.json({
        success:true,
        data: result
      });

    });

  });

});

/* ======================
   CHECK MISSING WORK LOG
====================== */
app.get("/checkMissingWorkLog", (req, res) => {

  if (!db) {
    return res.json({
      success: false,
      message: "Database not connected"
    });
  }

  const { user_mail, department } = req.query;

  if (!user_mail || !department) {
    return res.json({
      success: false,
      message: "Missing parameters"
    });
  }

  let tableName = "";

  if (department === "Social_Media_N_Website_Audit") {
    tableName = "social_media_n_website_audit_data";
  }
  else if (department === "Media_Monitoring") {
    tableName = "media_monitoring_data";
  }
  else if (department === "Brand_Infringement") {
    tableName = "brand_infringement";
  }
  else if (
    department === "Brand_Affiliate" ||
    department === "Brand_Safety_Affiliate"
  ) {
    tableName = "brand_affiliate";
  }
  else if (department === "Anti_Money_Laundering") {
    tableName = "anti_money_laundering_data";
  }
  else {
    return res.json({
      success: false,
      message: "Invalid department"
    });
  }

  const sql = `
    SELECT DISTINCT DATE(date) AS work_date
    FROM ${tableName}
    WHERE LOWER(TRIM(user_mail)) = LOWER(?)
    ORDER BY work_date DESC
  `;

  db.query(sql, [user_mail], (err, rows) => {

    if (err) {
      console.error(err);
      return res.json({
        success: false
      });
    }

    const submittedDates = new Set(
      rows.map(r => new Date(r.work_date).toISOString().split("T")[0])
    );

    let missingDays = 0;

    // Yesterday se count start hoga
    let d = new Date();
    d.setDate(d.getDate() - 1);

    while (true) {

      const dateStr = d.toISOString().split("T")[0];

      if (submittedDates.has(dateStr)) {
        break;
      }

      missingDays++;

      d.setDate(d.getDate() - 1);

      // Safety (100 days se jyada loop nahi chalega)
      if (missingDays >= 100) {
        break;
      }
    }

    let status = "ok";
    let message = "";

    if (missingDays >= 1 && missingDays <= 3) {

      status = "warning";

      message =
        `You have ${missingDays} pending work log(s). Please complete them.`;

    }
    else if (missingDays > 3) {

      status = "critical";

      message =
        `You have missed work logs for ${missingDays} consecutive days. Please contact your Team Lead.`;

    }

    res.json({
      success: true,
      status,
      missingDays,
      message
    });

  });

});

/* =====================================================
                  SHIFT MANAGEMENT APIs
===================================================== */

/* ==========================
   GET EMPLOYEE SHIFT
===================================================== */
app.get("/getEmployeeShift", (req, res) => {
    if (!db) {
        return res.json([]);
    }
    const { user_mail } = req.query;
    if (!user_mail) {
        return res.json([]);
    }
    const sql = `
        SELECT 
            es.id,
            es.user_mail,
            es.shift_id,
            DATE_FORMAT(es.shift_date, '%Y-%m-%d') AS shift_date,
            es.status,
            sm.shift_name,
            sm.start_time,
            sm.end_time,
            sm.color
        FROM employee_shift es
        LEFT JOIN shift_master sm
            ON es.shift_id = sm.id
        WHERE es.user_mail = ?
        ORDER BY es.shift_date ASC
    `;

    db.query(sql, [user_mail], (err, rows) => {
        if (err) {
            console.error(err);
            return res.json([]);
        }
        res.json(rows);
    });
});

/* ==========================
   GET TODAY ATTENDANCE
===================================================== */
app.get("/todayAttendance", (req, res) => {
    if (!db) {
        return res.json(null);
    }
    const { user_mail, date } = req.query;
    if (!user_mail) {
        return res.status(400).json({ error: "user_mail is required" });
    }

    // Get local date string YYYY-MM-DD
    const tzOffset = (new Date()).getTimezoneOffset() * 60000;
    const targetDate = date || (new Date(Date.now() - tzOffset)).toISOString().slice(0, 10);

    const sql = `
        SELECT * 
        FROM attendance_logs 
        WHERE user_mail = ? AND attendance_date = ?
        LIMIT 1
    `;

    db.query(sql, [user_mail, targetDate], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: "Database error" });
        }

        if (rows.length === 0) {
            return res.json({ 
                clockedIn: false, 
                clockedOut: false, 
                attendance: null, 
                activeBreak: null 
            });
        }

        const attendanceRecord = rows[0];

        const breakSql = `
            SELECT * 
            FROM break_logs 
            WHERE attendance_id = ?
            ORDER BY id DESC
        `;

        db.query(breakSql, [attendanceRecord.id], (err, breaks) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ error: "Database error" });
            }

            const activeBreak = breaks.find(b => b.break_end === null);

            res.json({
                clockedIn: attendanceRecord.clock_in !== null,
                clockedOut: attendanceRecord.clock_out !== null,
                attendance: attendanceRecord,
                activeBreak: activeBreak || null,
                allBreaks: breaks
            });
        });
    });
});

/* ==========================
   CREATE SHIFT TEMPLATE
========================== */
app.post("/createShiftTemplate", (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, message: "Database connection not available" });
    }

    const {
        id,
        shift_name,
        shift_code,
        start_time,
        end_time,
        color,
        break_start,
        break_end,
        working_hours,
        created_by
    } = req.body;

    if (!shift_name || !start_time || !end_time) {
        return res.status(400).json({ success: false, message: "Missing required fields (shift_name, start_time, end_time)" });
    }

    if (id) {
        const sql = `
            UPDATE shift_master
            SET
                shift_name = ?,
                shift_code = ?,
                start_time = ?,
                end_time = ?,
                break_start = ?,
                break_end = ?,
                working_hours = ?,
                color = ?
            WHERE id = ?
        `;
        db.query(sql, [
            shift_name,
            shift_code || shift_name.toUpperCase().substring(0, 10),
            start_time,
            end_time,
            break_start || null,
            break_end || null,
            working_hours || null,
            color || "#0078d4",
            id
        ], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: "Database update failed" });
            }
            res.json({ success: true, message: "Shift template updated successfully" });
        });
    } else {
        const sql = `
            INSERT INTO shift_master
            (
                shift_name,
                shift_code,
                start_time,
                end_time,
                break_start,
                break_end,
                working_hours,
                color,
                is_active,
                created_by
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
        `;

        db.query(sql, [
            shift_name,
            shift_code || shift_name.toUpperCase().substring(0, 10),
            start_time,
            end_time,
            break_start || null,
            break_end || null,
            working_hours || null,
            color || "#0078d4",
            created_by || "Admin"
        ], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: "Database insertion failed" });
            }
            res.json({ success: true, message: "Shift template created successfully", insertId: result.insertId });
        });
    }
});

/* ==========================
   GET EMPLOYEES
========================== */

app.get("/getEmployees", (req, res) => {

    if (!db) {
        return res.json([]);
    }

    const { department } = req.query;

    let sql = `
        SELECT
            User_Name,
            User_Mail,
            Employee_ID,
            Department,
            Designation
        FROM mis_user_data
        WHERE is_archived = 0
    `;

    const params = [];

    if (department) {
        sql += ` AND LOWER(TRIM(Department)) = LOWER(?)`;
        params.push(department);
    }

    sql += ` ORDER BY User_Name ASC`;

    db.query(sql, params, (err, rows) => {

        if (err) {
            console.error(err);
            return res.json([]);
        }

        res.json(rows);

    });

});

/* ==========================
   GET SHIFT MASTER
========================== */

app.get("/getShiftMaster", (req, res) => {

    if (!db) {
        return res.json([]);
    }

    const sql = `
        SELECT *
        FROM shift_master
        WHERE is_active = 1
        ORDER BY start_time
    `;

    db.query(sql, (err, rows) => {

        if (err) {

            console.error(err);

            return res.json([]);

        }

        res.json(rows);

    });

});

/* ==========================
   GET ASSIGNED SHIFTS
========================== */

app.get("/getAssignedShifts", (req, res) => {

    if (!db) {

        return res.json([]);

    }

    const sql = `
    SELECT
        es.id,
        es.user_mail,
        es.shift_id,
        DATE_FORMAT(es.shift_date, '%Y-%m-%d') AS shift_date,
        es.status,
        es.group_id,
        es.notes,
        es.custom_label,
        es.open_slots,
        COALESCE(es.color, sm.color) AS color,

        sm.shift_name,
        sm.start_time,
        sm.end_time,

        u.User_Name,
        u.Department

    FROM employee_shift es

    LEFT JOIN shift_master sm
        ON es.shift_id = sm.id

    LEFT JOIN mis_user_data u
        ON es.user_mail = u.User_Mail

    ORDER BY es.shift_date ASC

    `;

    db.query(sql, (err, rows) => {

        if (err) {

            console.error(err);

            return res.json([]);

        }

        res.json(rows);
    });

});

// Clean and format recipient emails: strips 'admin_', removes test emails (.admin / director)
const cleanEmailRecipients = (emails) => {
    const cleaned = [];
    emails.forEach(email => {
        if (!email) return;
        let cleanedEmail = email.trim().toLowerCase();

        // 1. If email starts with 'admin_', strip it
        if (cleanedEmail.startsWith("admin_")) {
            cleanedEmail = cleanedEmail.substring(6);
        }

        // 2. Ignore test IDs (contains '.admin' or contains 'director@')
        if (cleanedEmail.includes(".admin") || cleanedEmail.includes("director@")) {
            return;
        }

        // 3. Simple validation & uniqueness
        if (cleanedEmail.includes("@") && cleanedEmail.includes(".") && !cleaned.includes(cleanedEmail)) {
            cleaned.push(cleanedEmail);
        }
    });
    return cleaned;
};

// Helper to send work log submission email via Brevo HTTP API
const sendSubmissionEmail = (user_mail, department, date, rawData) => {
    if (!db || !user_mail) return;

    // 1. Get employee name
    const empSql = "SELECT User_Name FROM mis_user_data WHERE User_Mail = ? LIMIT 1";
    db.query(empSql, [user_mail], (err, empRows) => {
        if (err || empRows.length === 0) return;
        const employeeName = empRows[0].User_Name || "Employee";

        // 2. Fetch Project Leads & Admins & Directors of the SAME department only
        const leadsSql = `
            SELECT User_Mail, Role, Designation 
            FROM mis_user_data 
            WHERE is_archived = 0 
              AND LOWER(TRIM(Department)) = LOWER(TRIM(?))
              AND (Designation = 'Project Lead' OR Role = 'Admin' OR Role = 'Director')
        `;
        db.query(leadsSql, [department], (err, leadRows) => {
            if (err) {
                console.error("Error fetching leads for submission notification:", err);
                return;
            }

            const rawRecipients = [user_mail];
            leadRows.forEach(r => {
                if (r.User_Mail) {
                    rawRecipients.push(r.User_Mail);
                }
            });
            const recipients = cleanEmailRecipients(rawRecipients);
            if (recipients.length === 0) return;

            // 3. Format the fields from rawData
            let tableRowsHtml = "";
            const skipKeys = ["user_name", "user_mail", "department", "role", "date", "rotation", "id", "created_at", "approval_status"];
            
            Object.keys(rawData).forEach(key => {
                const cleanKey = key.replace(/\[\]$/, '');
                if (skipKeys.includes(cleanKey.toLowerCase())) return;

                // Format value nicely
                let val = rawData[key];
                if (Array.isArray(val)) val = val.join(", ");
                if (val === null || val === undefined || val === "") return;

                // Make key readable
                const readableKey = cleanKey
                    .replace(/_/g, " ")
                    .replace(/([A-Z])/g, " $1")
                    .trim()
                    .replace(/\s+/g, " ");

                tableRowsHtml += `
                    <tr>
                        <td style="padding: 10px 12px; border-bottom: 1px solid #f1f5f9; font-weight: 500; color: #64748b; font-size: 13px; width: 220px; text-transform: capitalize;">${readableKey}</td>
                        <td style="padding: 10px 12px; border-bottom: 1px solid #f1f5f9; color: #0f172a; font-size: 13px; font-weight: 600;">${val}</td>
                    </tr>
                `;
            });

            if (tableRowsHtml === "") return; // Nothing filled

            const formattedDate = new Date(date).toLocaleDateString("en-US", {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const htmlContent = `
                <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 650px; margin: 0 auto; padding: 30px; background-color: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0;">
                    <div style="text-align: center; margin-bottom: 25px;">
                        <span style="background-color: #dbeafe; color: #1e40af; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 100px; text-transform: uppercase; letter-spacing: 0.05em;">Work Log Submitted</span>
                        <h2 style="color: #0f172a; margin: 10px 0 0 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">Daily Activity Summary</h2>
                        <p style="color: #64748b; font-size: 14px; margin-top: 6px;">Activity log filed by <strong>${employeeName}</strong> for <strong>${department}</strong></p>
                    </div>
                    
                    <div style="background-color: #ffffff; border-radius: 12px; padding: 25px; border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                        <div style="display: flex; justify-content: space-between; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; margin-bottom: 15px;">
                            <span style="font-size: 13px; color: #64748b;">Submission Date:</span>
                            <span style="font-size: 13px; font-weight: 600; color: #0f172a;">${formattedDate}</span>
                        </div>
                        
                        <table style="width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="background-color: #f8fafc;">
                                    <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #475569; border-bottom: 2px solid #e2e8f0;">Field / Task</th>
                                    <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #475569; border-bottom: 2px solid #e2e8f0;">Value / Detail</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${tableRowsHtml}
                            </tbody>
                        </table>
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px; font-size: 11px; color: #94a3b8;">
                        <p style="margin: 0;">This email was automatically sent to the Employee, Project Leads, and Administrators of ${department} department.</p>
                    </div>
                </div>
            `;

            // Prepare Brevo API recipients list
            const toPayload = recipients.map(email => ({ email }));

            fetch("https://api.brevo.com/v3/smtp/email", {
                method: "POST",
                headers: {
                    "accept": "application/json",
                    "api-key": process.env.BREVO_API_KEY || "",
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    sender: {
                        name: "Pixeltruth Scheduler",
                        email: "pixeltruth.notify@gmail.com"
                    },
                    to: toPayload,
                    cc: [{ email: "jigyasha.pathak@pixeltruth.com", name: "Jigyasha Pathak" }],
                    subject: `📝 Work Log Submitted: ${employeeName} - ${formattedDate}`,
                    htmlContent: htmlContent
                })
            })
            .then(response => {
                if (!response.ok) {
                    return response.text().then(text => {
                        throw new Error(`Brevo HTTP Error: ${response.status} - ${text}`);
                    });
                }
                return response.json();
            })
            .then(data => {
                console.log("✅ Work log submission notification sent successfully via Brevo to:", recipients, data);
            })
            .catch(error => {
                console.error("❌ Error sending work log submission email via Brevo:", error);
            });
        });
    });
};

// Helper to send Shift email notification via Brevo HTTP API
const sendShiftEmailNotification = (user_mail, shift_id, shift_date, assigned_by, group_id, notes, custom_label) => {
    if (!db || !user_mail) return;

    // 1. Get employee name
    const empSql = "SELECT User_Name FROM mis_user_data WHERE User_Mail = ? LIMIT 1";
    db.query(empSql, [user_mail], (err, empRows) => {
        if (err || empRows.length === 0) return;
        const employeeName = empRows[0].User_Name || "Employee";

        // 2. Get shift details
        const shiftSql = "SELECT shift_name, start_time, end_time FROM shift_master WHERE id = ? LIMIT 1";
        db.query(shiftSql, [shift_id], (err, shiftRows) => {
            if (err || shiftRows.length === 0) return;
            const sName = shiftRows[0].shift_name || "Custom Timing";
            const sStart = shiftRows[0].start_time || "";
            const sEnd = shiftRows[0].end_time || "";

            // 3. Get group name (if applicable)
            let groupName = "Unnamed group";
            const getGroup = (callback) => {
                if (group_id && group_id !== "unnamed") {
                    db.query("SELECT group_name FROM shift_groups WHERE id = ? LIMIT 1", [group_id], (err, gRows) => {
                        if (!err && gRows.length > 0) {
                            groupName = gRows[0].group_name;
                        }
                        callback();
                    });
                } else {
                    callback();
                }
            };

            getGroup(() => {
                const formattedDate = new Date(shift_date).toLocaleDateString("en-US", {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric'
                });

                const htmlContent = `
                    <div style="font-family: 'Inter', system-ui, -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; background-color: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0;">
                        <div style="text-align: center; margin-bottom: 25px;">
                            <h2 style="color: #0f172a; margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">New Shift Assignment</h2>
                            <p style="color: #64748b; font-size: 14px; margin-top: 6px;">You have been assigned a new shift in the schedule</p>
                        </div>
                        
                        <div style="background-color: #ffffff; border-radius: 12px; padding: 25px; border: 1px solid #e2e8f0; box-shadow: 0 1px 3px rgba(0,0,0,0.02);">
                            <h3 style="margin-top: 0; color: #1e293b; font-size: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px; font-weight: 600;">Shift Details</h3>
                            
                            <table style="width: 100%; border-collapse: collapse; font-size: 14px; color: #475569;">
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b; width: 120px;">Employee</td>
                                    <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${employeeName}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b;">Shift Date</td>
                                    <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${formattedDate}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b;">Shift Time</td>
                                    <td style="padding: 8px 0; color: #2563eb; font-weight: 600;">${sStart} - ${sEnd} (${sName})</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b;">Team/Group</td>
                                    <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${groupName}</td>
                                </tr>
                                ${custom_label ? `
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b;">Custom Label</td>
                                    <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${custom_label}</td>
                                </tr>` : ''}
                                ${notes ? `
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b; vertical-align: top;">Notes</td>
                                    <td style="padding: 8px 0; color: #475569; font-style: italic;">${notes}</td>
                                </tr>` : ''}
                                ${assigned_by ? `
                                <tr>
                                    <td style="padding: 8px 0; font-weight: 500; color: #64748b;">Assigned By</td>
                                    <td style="padding: 8px 0; color: #0f172a; font-weight: 600;">${assigned_by}</td>
                                </tr>` : ''}
                            </table>
                        </div>
                        
                        <div style="text-align: center; margin-top: 30px; font-size: 12px; color: #94a3b8;">
                            <p style="margin: 0;">This is an automated notification from Pixeltruth MIS Portal.</p>
                        </div>
                    </div>
                `;

                fetch("https://api.brevo.com/v3/smtp/email", {
                    method: "POST",
                    headers: {
                        "accept": "application/json",
                        "api-key": process.env.BREVO_API_KEY || "",
                        "content-type": "application/json"
                    },
                    body: JSON.stringify({
                        sender: {
                            name: "Pixeltruth Scheduler",
                            email: "pixeltruth.notify@gmail.com"
                        },
                        to: [
                            {
                                email: user_mail,
                                name: employeeName
                            }
                        ],
                        cc: [{ email: "jigyasha.pathak@pixeltruth.com", name: "Jigyasha Pathak" }],
                        subject: `🚨 New Shift Assigned: ${formattedDate}`,
                        htmlContent: htmlContent
                    })
                })
                .then(response => {
                    if (!response.ok) {
                        return response.text().then(text => {
                            throw new Error(`Brevo HTTP Error: ${response.status} - ${text}`);
                        });
                    }
                    return response.json();
                })
                .then(data => {
                    console.log("✅ Shift notification email sent successfully via Brevo HTTP API to:", user_mail, data);
                })
                .catch(error => {
                    console.error("❌ Error sending shift notification email via Brevo HTTP API:", error);
                });
            });
        });
    });
};

/* ==========================
   ASSIGN SHIFT
========================== */

app.post("/assignShift", (req, res) => {
    if (!db) {
        return res.json({
            success: false,
            message: "Database not connected"
        });
    }

    const {
        user_mail,
        shift_id,
        shift_date,
        assigned_by,
        group_id,
        notes,
        custom_label,
        open_slots,
        color
    } = req.body;

    if (!shift_id || !shift_date) {
        return res.json({
            success: false,
            message: "Missing required fields"
        });
    }

    // Duplicate check only if user_mail is specified (regular shift assignment)
    if (user_mail) {
        const checkSql = `
            SELECT id
            FROM employee_shift
            WHERE user_mail = ?
            AND shift_date = ?
        `;

        db.query(checkSql, [user_mail, shift_date], (err, rows) => {
            if (err) {
                console.error(err);
                return res.json({ success: false });
            }

            if (rows.length > 0) {
                return res.json({
                    success: false,
                    message: "Shift already assigned"
                });
            }

            doInsert();
        });
    } else {
        doInsert();
    }

    function doInsert() {
        const insertSql = `
            INSERT INTO employee_shift
            (
                user_mail,
                shift_id,
                shift_date,
                status,
                assigned_by,
                group_id,
                notes,
                custom_label,
                open_slots,
                color
            )
            VALUES
            (?, ?, ?, 'Assigned', ?, ?, ?, ?, ?, ?)
        `;

        db.query(
            insertSql,
            [
                user_mail || null,
                shift_id,
                shift_date,
                assigned_by || "",
                group_id || null,
                notes || null,
                custom_label || null,
                open_slots || 1,
                color || null
            ],
            err => {
                if (err) {
                    console.error("Error inserting employee shift:", err);
                    return res.json({ success: false });
                }

                res.json({
                    success: true,
                    message: "Shift Assigned Successfully"
                });

                // Send email notification asynchronously
                sendShiftEmailNotification(user_mail, shift_id, shift_date, assigned_by, group_id, notes, custom_label);
            }
        );
    }
});


/* ==========================
   UPDATE SHIFT
========================== */

app.put("/updateShift", (req, res) => {
    if (!db) {
        return res.json({
            success: false
        });
    }

    const {
        id,
        shift_id,
        shift_date,
        status,
        user_mail,
        group_id,
        notes,
        custom_label,
        open_slots,
        color
    } = req.body;

    if (!id) {
        return res.json({
            success: false
        });
    }

    const sql = `
        UPDATE employee_shift
        SET
            shift_id = ?,
            shift_date = ?,
            status = ?,
            user_mail = ?,
            group_id = ?,
            notes = ?,
            custom_label = ?,
            open_slots = ?,
            color = ?
        WHERE id = ?
    `;

    db.query(
        sql,
        [
            shift_id,
            shift_date,
            status,
            user_mail || null,
            group_id || null,
            notes || null,
            custom_label || null,
            open_slots || 1,
            color || null,
            id
        ],
        err => {
            if (err) {
                console.error("Error updating employee shift:", err);
                return res.json({ success: false });
            }

            res.json({
                success: true,
                message: "Shift Updated"
            });

            // Send email notification asynchronously
            sendShiftEmailNotification(user_mail, shift_id, shift_date, null, group_id, notes, custom_label);
        }
    );
});


/* ==========================
   DELETE SHIFT
========================== */

app.delete("/deleteShift/:id", (req, res) => {

    if (!db) {

        return res.json({
            success: false
        });

    }

    const id = req.params.id;

    const sql = `
        DELETE
        FROM employee_shift
        WHERE id = ?
    `;

    db.query(

        sql,

        [id],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success: false
                });

            }

            res.json({

                success: true,
                message: "Shift Deleted"

            });

        }

    );

});
/* ==========================
   GET LEAVE REQUESTS
========================== */

app.get("/getLeaveRequests", (req, res) => {

    if (!db) return res.json([]);

    const sql = `
        SELECT
            lr.*,
            u.User_Name,
            u.Department
        FROM leave_requests lr
        LEFT JOIN mis_user_data u
            ON lr.user_mail = u.User_Mail
        ORDER BY lr.created_at DESC
    `;

    db.query(sql, (err, rows) => {

        if (err) {

            console.error(err);

            return res.json([]);

        }

        res.json(rows);

    });

});


/* ==========================
   APPROVE LEAVE
========================== */

app.post("/approveLeave", (req, res) => {

    if (!db) {

        return res.json({ success:false });

    }

    const {

        id,
        approved_by,
        approval_note

    } = req.body;

    const sql = `
        UPDATE leave_requests
        SET
            status='Approved',
            approved_by=?,
            approval_note=?
        WHERE id=?
    `;

    db.query(

        sql,

        [
            approved_by || "",
            approval_note || "",
            id
        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success:false
                });

            }

            res.json({
                success:true,
                message:"Leave Approved"
            });

        }

    );

});


/* ==========================
   REJECT LEAVE
========================== */

app.post("/rejectLeave", (req, res) => {

    if (!db) {

        return res.json({ success:false });

    }

    const {

        id,
        approved_by,
        approval_note

    } = req.body;

    const sql = `
        UPDATE leave_requests
        SET
            status='Rejected',
            approved_by=?,
            approval_note=?
        WHERE id=?
    `;

    db.query(

        sql,

        [
            approved_by || "",
            approval_note || "",
            id
        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success:false
                });

            }

            res.json({

                success:true,
                message:"Leave Rejected"

            });

        }

    );

});


/* ==========================
   GET SHIFT REQUESTS
========================== */

app.get("/getShiftRequests", (req, res) => {

    if (!db) return res.json([]);

    const sql = `

        SELECT

            sr.*,

            u.User_Name,

            oldShift.shift_name AS old_shift,

            newShift.shift_name AS new_shift

        FROM shift_requests sr

        LEFT JOIN mis_user_data u

            ON sr.user_mail = u.User_Mail

        LEFT JOIN shift_master oldShift

            ON sr.old_shift_id = oldShift.id

        LEFT JOIN shift_master newShift

            ON sr.new_shift_id = newShift.id

        ORDER BY sr.created_at DESC

    `;

    db.query(sql, (err, rows) => {

        if (err) {

            console.error(err);

            return res.json([]);

        }

        res.json(rows);

    });

});


/* ==========================
   APPROVE SHIFT REQUEST
========================== */

app.post("/approveShiftRequest", (req, res) => {

    if (!db) {

        return res.json({
            success:false
        });

    }

    const {

        id,
        approved_by

    } = req.body;

    const getSql = `
        SELECT *
        FROM shift_requests
        WHERE id=?
    `;

    db.query(getSql,[id],(err,result)=>{

        if(err){

            console.error(err);

            return res.json({
                success:false
            });

        }

        if(result.length===0){

            return res.json({
                success:false
            });

        }

        const reqData=result[0];

       const updateShift = `
          UPDATE employee_shift
          SET shift_id = ?
          WHERE user_mail = ?
          AND shift_date = ?
      `;

        db.query(

            updateShift,

            [

                reqData.new_shift_id,

                reqData.user_mail,
               reqData.shift_date

            ],

            err=>{

                if(err){

                    console.error(err);

                    return res.json({
                        success:false
                    });

                }

                db.query(

                    `UPDATE shift_requests
                     SET status='Approved',
                     approved_by=?
                     WHERE id=?`,

                    [

                        approved_by || "",

                        id

                    ],

                    err=>{

                        if(err){

                            console.error(err);

                            return res.json({
                                success:false
                            });

                        }

                        res.json({

                            success:true,

                            message:"Shift Request Approved"

                        });

                    }

                );

            }

        );

    });

});


/* ==========================
   REJECT SHIFT REQUEST
========================== */

app.post("/rejectShiftRequest", (req, res) => {

    if (!db) {

        return res.json({
            success:false
        });

    }

    const {

        id,
        approved_by

    } = req.body;

    const sql=`

        UPDATE shift_requests

        SET

        status='Rejected',

        approved_by=?

        WHERE id=?

    `;

    db.query(

        sql,

        [

            approved_by || "",

            id

        ],

        err=>{

            if(err){

                console.error(err);

                return res.json({
                    success:false
                });

            }

            res.json({

                success:true,

                message:"Shift Request Rejected"

            });

        }

    );

});
/* ==========================
   CREATE SHIFT REQUEST
========================== */

app.post("/createShiftRequest", (req, res) => {

    if (!db) {
        return res.json({
            success: false
        });
    }

    const {

        user_mail,
        request_type,
        old_shift_id,
        new_shift_id,
        shift_date,
        reason

    } = req.body;

    if (
        !user_mail ||
        !old_shift_id ||
        !new_shift_id ||
        !shift_date
    ) {

        return res.json({
            success: false,
            message: "Missing Required Fields"
        });

    }

    const sql = `

        INSERT INTO shift_requests
        (

            user_mail,
            request_type,
            old_shift_id,
            new_shift_id,
            shift_date,
            reason

        )

        VALUES

        (

            ?, ?, ?, ?, ?, ?

        )

    `;

    db.query(

        sql,

        [

            user_mail,

            request_type || "Shift Change",

            old_shift_id,

            new_shift_id,

            shift_date,

            reason || ""

        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success: false
                });

            }

            res.json({

                success: true,

                message: "Shift Request Submitted"

            });

        }

    );

});


/* ==========================
   CREATE LEAVE REQUEST
========================== */

app.post("/createLeaveRequest", (req, res) => {

    if (!db) {

        return res.json({
            success: false
        });

    }

    const {

        user_mail,
        leave_type,
        from_date,
        to_date,
        reason

    } = req.body;

    const sql = `

        INSERT INTO leave_requests

        (

            user_mail,
            leave_type,
            from_date,
            to_date,
            reason

        )

        VALUES

        (

            ?, ?, ?, ?, ?

        )

    `;

    db.query(

        sql,

        [

            user_mail,

            leave_type,

            from_date,

            to_date,

            reason

        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({

                    success: false

                });

            }

            res.json({

                success: true,

                message: "Leave Request Submitted"

            });

        }

    );

});


/* ==========================
   GET ATTENDANCE
========================== */

app.get("/getAttendance", (req, res) => {

    if (!db) {

        return res.json([]);

    }

    const { user_mail } = req.query;

    let sql = `

        SELECT

            a.*,

            s.shift_name,

            u.User_Name

        FROM attendance_logs a

        LEFT JOIN shift_master s

            ON a.shift_id = s.id

        LEFT JOIN mis_user_data u

            ON a.user_mail = u.User_Mail

    `;

    const params = [];

    if (user_mail) {

        sql += ` WHERE a.user_mail = ?`;

        params.push(user_mail);

    }

    sql += ` ORDER BY attendance_date DESC`;

    db.query(

        sql,

        params,

        (err, rows) => {

            if (err) {

                console.error(err);

                return res.json([]);

            }

            res.json(rows);

        }

    );

});
/* ==========================
   CLOCK IN
========================== */

app.post("/clockIn", (req, res) => {

    if (!db) return res.json({ success: false });

    const {
        user_mail,
        shift_id,
        attendance_date,
        clock_in,
        clock_in_ip,
        clock_in_location
    } = req.body;

    const getShift = `
        SELECT start_time,end_time
        FROM shift_master
        WHERE id=?
    `;

    db.query(getShift, [shift_id], (err, shift) => {

        if (err || shift.length === 0) {
            return res.json({ success: false });
        }

        const sql = `
            INSERT INTO attendance_logs
            (
                user_mail,
                shift_id,
                attendance_date,
                shift_start,
                shift_end,
                clock_in,
                clock_in_ip,
                clock_in_location
            )
            VALUES
            (?,?,?,?,?,?,?,?)
        `;

        db.query(sql, [

            user_mail,
            shift_id,
            attendance_date,
            shift[0].start_time,
            shift[0].end_time,
            clock_in,
            clock_in_ip || "",
            clock_in_location || ""

        ], err => {

            if (err) {
                console.error(err);
                return res.json({ success: false });
            }

            res.json({
                success: true,
                message: "Clock In Successful"
            });

        });

    });

});


/* ==========================
   CLOCK OUT
========================== */

app.post("/clockOut", (req, res) => {

    if (!db) return res.json({ success: false });

    const {

        attendance_id,
        clock_out,
        clock_out_ip,
        clock_out_location,
        worked_hours,
        paid_hours,
        overtime_hours

    } = req.body;

    const sql = `
        UPDATE attendance_logs

        SET

        clock_out=?,
        clock_out_ip=?,
        clock_out_location=?,
        worked_hours=?,
        paid_hours=?,
        overtime_hours=?

        WHERE id=?
    `;

    db.query(

        sql,

        [

            clock_out,
            clock_out_ip || "",
            clock_out_location || "",
            worked_hours,
            paid_hours,
            overtime_hours,
            attendance_id

        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success: false
                });

            }

            res.json({

                success: true,
                message: "Clock Out Successful"

            });

        }

    );

});


/* ==========================
   BREAK START
========================== */

app.post("/startBreak", (req, res) => {

    if (!db) return res.json({ success: false });

    const {

        attendance_id,
        break_note

    } = req.body;

    const sql = `

        INSERT INTO break_logs

        (

            attendance_id,
            break_start,
            break_note

        )

        VALUES

        (

            ?,NOW(),?

        )

    `;

    db.query(

        sql,

        [

            attendance_id,
            break_note || ""

        ],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success: false
                });

            }

            res.json({

                success: true,
                message: "Break Started"

            });

        }

    );

});


/* ==========================
   BREAK END
========================== */

app.post("/endBreak", (req, res) => {

    if (!db) return res.json({ success: false });

    const { break_id } = req.body;

    const sql = `

        UPDATE break_logs

        SET

        break_end=NOW(),

        break_hours=TIMESTAMPDIFF(MINUTE,break_start,NOW())/60

        WHERE id=?

    `;

    db.query(

        sql,

        [break_id],

        err => {

            if (err) {

                console.error(err);

                return res.json({
                    success: false
                });

            }

            res.json({

                success: true,
                message: "Break Ended"

            });

        }

    );

});


/* ==========================
   GET BREAK LOGS
========================== */

app.get("/getBreakLogs", (req, res) => {

    if (!db) return res.json([]);

    const { attendance_id } = req.query;

    const sql = `

        SELECT *

        FROM break_logs

        WHERE attendance_id=?

        ORDER BY break_start DESC

    `;

    db.query(

        sql,

        [attendance_id],

        (err, rows) => {

            if (err) {

                console.error(err);

                return res.json([]);

            }

            res.json(rows);

        }

    );

});


/* ==========================
   GET OPEN SHIFTS
========================== */

app.get("/getOpenShifts", (req, res) => {

    if (!db) return res.json([]);

    const sql = `

        SELECT *

        FROM shift_master

        WHERE is_active=1

        ORDER BY start_time

    `;

    db.query(sql, (err, rows) => {

        if (err) {

            console.error(err);

            return res.json([]);

        }

        res.json(rows);

    });

});

/* ==========================================================
   SHIFT GROUPS APIS
   ========================================================== */

// 1. GET /getGroups
app.get("/getGroups", (req, res) => {
    if (!db) return res.json([]);
    const { department } = req.query;
    if (!department) {
        return res.status(400).json({ error: "Department is required" });
    }

    const getGroupsSql = `SELECT * FROM shift_groups WHERE LOWER(TRIM(department)) = LOWER(?)`;
    db.query(getGroupsSql, [department], (err, groups) => {
        if (err) {
            console.error("Error fetching shift groups:", err);
            return res.status(500).json({ error: "Database error" });
        }

        const getMembersSql = `
            SELECT m.group_id, m.user_mail, u.User_Name, u.Department, u.Designation
            FROM shift_group_members m
            JOIN mis_user_data u ON m.user_mail = u.User_Mail
            WHERE LOWER(TRIM(u.Department)) = LOWER(?) AND u.is_archived = 0
        `;
        db.query(getMembersSql, [department], (err, members) => {
            if (err) {
                console.error("Error fetching shift group members:", err);
                return res.status(500).json({ error: "Database error" });
            }

            // Map members to groups
            const result = groups.map(g => {
                return {
                    ...g,
                    members: members.filter(m => m.group_id === g.id)
                };
            });
            res.json(result);
        });
    });
});

// 2. POST /createGroup
app.post("/createGroup", (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    const { group_name, department } = req.body;
    if (!group_name || !department) {
        return res.status(400).json({ error: "Group name and department are required" });
    }

    const sql = `INSERT INTO shift_groups (group_name, department) VALUES (?, ?)`;
    db.query(sql, [group_name, department], (err, result) => {
        if (err) {
            console.error("Error creating group:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json({ success: true, groupId: result.insertId });
    });
});

// 3. POST /deleteGroup
app.post("/deleteGroup", (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    const { group_id } = req.body;
    if (!group_id) {
        return res.status(400).json({ error: "Group ID is required" });
    }

    const sql = `DELETE FROM shift_groups WHERE id = ?`;
    db.query(sql, [group_id], (err, result) => {
        if (err) {
            console.error("Error deleting group:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json({ success: true });
    });
});

// 4. POST /renameGroup
app.post("/renameGroup", (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    const { group_id, group_name } = req.body;
    if (!group_id || !group_name) {
        return res.status(400).json({ error: "Group ID and group name are required" });
    }

    const sql = `UPDATE shift_groups SET group_name = ? WHERE id = ?`;
    db.query(sql, [group_name, group_id], (err, result) => {
        if (err) {
            console.error("Error renaming group:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json({ success: true });
    });
});

// 5. POST /addGroupMember
app.post("/addGroupMember", (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    const { group_id, user_mail } = req.body;
    if (!group_id || !user_mail) {
        return res.status(400).json({ error: "Group ID and user mail are required" });
    }

    const sql = `INSERT INTO shift_group_members (group_id, user_mail) VALUES (?, ?) ON DUPLICATE KEY UPDATE group_id = VALUES(group_id)`;
    db.query(sql, [group_id, user_mail], (err, result) => {
        if (err) {
            console.error("Error adding group member:", err);
            return res.status(500).json({ error: "Database error" });
        }
        res.json({ success: true });
    });
});

// 7. POST /updateGroupMembers
app.post("/updateGroupMembers", (req, res) => {
    if (!db) return res.status(500).json({ error: "Database not connected" });
    const { group_id, emails } = req.body;
    if (!group_id || !Array.isArray(emails)) {
        return res.status(400).json({ error: "Group ID and emails array are required" });
    }

    if (group_id === "unnamed") {
        if (emails.length === 0) return res.json({ success: true });
        const ungroupSql = `DELETE FROM shift_group_members WHERE user_mail IN (?)`;
        db.query(ungroupSql, [emails], (err) => {
            if (err) {
                console.error("Error ungrouping employees:", err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ success: true });
        });
        return;
    }

    // Delete all current members for this group
    const deleteSql = `DELETE FROM shift_group_members WHERE group_id = ?`;
    db.query(deleteSql, [group_id], (err) => {
        if (err) {
            console.error("Error clearing group members:", err);
            return res.status(500).json({ error: "Database error" });
        }

        if (emails.length === 0) {
            return res.json({ success: true });
        }

        // Bulk insert new members
        const insertSql = `INSERT INTO shift_group_members (group_id, user_mail) VALUES ?`;
        const values = emails.map(email => [group_id, email]);
        
        db.query(insertSql, [values], (err) => {
            if (err) {
                console.error("Error bulk inserting group members:", err);
                return res.status(500).json({ error: "Database error" });
            }
            res.json({ success: true });
        });
    });
});

app.post("/deleteShiftTemplate", (req, res) => {
    if (!db) {
        return res.status(500).json({ success: false, message: "Database connection not available" });
    }
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({ success: false, message: "Missing template ID" });
    }

    // First delete dependent assignments in employee_shift
    const deleteAssignmentsSql = "DELETE FROM employee_shift WHERE shift_id = ?";
    db.query(deleteAssignmentsSql, [id], (err) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ success: false, message: "Database dependency deletion failed" });
        }

        // Then delete the template
        const deleteTemplateSql = "DELETE FROM shift_master WHERE id = ?";
        db.query(deleteTemplateSql, [id], (err, result) => {
            if (err) {
                console.error(err);
                return res.status(500).json({ success: false, message: "Database deletion failed" });
            }
            res.json({ success: true, message: "Shift template deleted successfully" });
        });
    });
});

/* ======================
/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
