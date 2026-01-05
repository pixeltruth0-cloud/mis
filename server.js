const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");

const app = express();

/* ======================
   Middleware
====================== */
app.use(cors());
app.use(express.json());

/* ======================
   Database Connection
====================== */
let db = null;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL not found in environment variables");
} else {
  try {
    db = mysql.createConnection(process.env.DATABASE_URL);

    db.connect((err) => {
      if (err) {
        console.error("❌ DB connection failed:", err.message);
        db = null;
      } else {
        console.log("✅ DB connected successfully");
      }
    });
  } catch (e) {
    console.error("❌ DB init error:", e.message);
    db = null;
  }
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
    return res.status(500).json({
      success: false,
      message: "Database not connected",
    });
  }

  const { User_Mail, Password, Role, Department } = req.body;

  if (!User_Mail || !Password || !Role || !Department) {
    return res.json({
      success: false,
      message: "All fields required",
    });
  }

  const sql = `
    SELECT * FROM mis_user_data
    WHERE User_Mail = ?
      AND Password = ?
      AND Role = ?
      AND Department = ?
    LIMIT 1
  `;

  db.query(sql, [User_Mail, Password, Role, Department], (err, results) => {
    if (err) {
      console.error("❌ Login DB error:", err.message);
      return res.status(500).json({
        success: false,
        message: "Database error",
      });
    }

    if (!results || results.length === 0) {
      return res.json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const user = results[0];

    /* ======================
       REDIRECT URL LOGIC
    ====================== */
    const FRONTEND_BASE_URL = "https://pixeltruth.com/mis";
    let redirectUrl = `${FRONTEND_BASE_URL}/${user.Department}/dashboard.html`;

    if (user.Role === "HR") {
      redirectUrl = `${FRONTEND_BASE_URL}/HR/${user.Department}/HR_dashboard.html`;
    } else if (user.Role === "Team_Lead") {
      redirectUrl = `${FRONTEND_BASE_URL}/TL/${user.Department}/TL_dashboard.html`;
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
        Reporting_Person: user.Reporting_Person || null,
      },
    });
  });
});

{
  date,

  // Website Audit
  Website_Audit_Brand,
  Website_Audit_Type_Of_Task,
  Website_Audit_hours,
  Website_Audit_minutes,
  Website_Audit_Remark,
  Website_Audit_Status,

  // Social Media Audit
  Social_Media_Audit_Brand,
  Social_Media_Audit_Type_Of_Task,
  Social_Media_Audit_hours,
  Social_Media_Audit_minutes,
  Social_Media_Audit_Remark,
  Social_Media_Audit_Status,

  // Stationary
  Stationary_Brand,
  Stationary_Project,
  Stationary_Count,
  Stationary_hours,
  Stationary_minutes,
  Stationary_Remark,

  // Real Estimated
  Real_estimated_Brand,
  Real_estimated_Categories,
  Real_estimated_Count,
  Real_estimated_hours,
  Real_estimated_minutes,
  Real_estimated_Remark,

  // Incent
  Incent_Brand,
  Incent_Count,
  Incent_Eastat_hours,
  Incent_Eastat_minutes,
  Incent_Remark,

  // ITC Cigarette
  ITC_Cigarette_Platform,
  ITC_Cigarette_Count,
  ITC_Cigarette_hours,
  ITC_Cigarette_minutes,
  ITC_Cigarette_Remark,

  // User Info
  user_name,
  user_mail,
  department
}
app.post("/submitProjectData", (req, res) => {
  if (!db) {
    return res.json({
      success: false,
      message: "Database not connected",
    });
  }

  const data = req.body;

  if (!data || Object.keys(data).length === 0) {
    return res.json({
      success: false,
      message: "No data received",
    });
  }

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
      return res.json({
        success: false,
        message: "Insert failed",
      });
    }

    return res.json({
      success: true,
      message: "Data inserted successfully",
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
