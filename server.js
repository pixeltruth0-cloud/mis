const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const multer = require("multer");
const session = require("express-session");

const app = express();
const upload = multer(); // REQUIRED FOR FORMDATA

/* ======================
   Middleware
====================== */
app.use(
  cors({
    origin: "https://pixeltruth.com", // frontend domain
    credentials: true
  })
);

app.use(express.json());

app.use(
  session({
    name: "pixeltruth.sid",
    secret: "pixeltruth_secret_key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // keep false (Render/Railway proxy handles HTTPS)
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 8 // 8 hours
    }
  })
);

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

    // 🔐 SESSION SET
    req.session.User_Mail = user.User_Mail;
    req.session.Role = user.Role;
    req.session.Department = user.Department;
    req.session.Employee_ID = user.Employee_ID;

    const BASE_URL = "https://pixeltruth.com/mis";
    let redirectUrl = `${BASE_URL}/${user.Department}/dashboard.html`;

    if (user.Role === "HR") {
      redirectUrl = `${BASE_URL}/HR/${user.Department}/HR_dashboard.html`;
    } else if (user.Role === "Team_Lead") {
      redirectUrl = `${BASE_URL}/TL/${user.Department}/TL_dashboard.html`;
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
   DASHBOARD DATA (ROLE BASED)
====================== */
app.get("/getDepartmentData", (req, res) => {
  if (!req.session || !req.session.User_Mail) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { Role, User_Mail, Department } = req.session;

  let sql = "";
  let params = [];

  if (Role === "Admin" || Role === "Manager" || Role === "Team_Lead") {
    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
      WHERE department = ?
      ORDER BY date DESC
    `;
    params = [Department];
  } else {
    sql = `
      SELECT *
      FROM social_media_n_website_audit_data
      WHERE user_mail = ?
      ORDER BY date DESC
    `;
    params = [User_Mail];
  }

  db.query(sql, params, (err, result) => {
    if (err) {
      console.error("❌ DB Error:", err.message);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(result);
  });
});

/* ======================
   LOGOUT
====================== */
app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("pixeltruth.sid");
    res.json({ success: true });
  });
});

/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
