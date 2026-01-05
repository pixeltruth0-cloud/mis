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
      message: "Database not connected"
    });
  }

  const { User_Mail, Password, Role, Department } = req.body;

  console.log("🔐 Login request:", req.body);

  if (!User_Mail || !Password || !Role || !Department) {
    return res.json({
      success: false,
      message: "All fields required"
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

  db.query(
    sql,
    [User_Mail, Password, Role, Department],
    (err, results) => {
      if (err) {
        console.error("❌ Login DB error:", err.message);
        return res.status(500).json({
          success: false,
          message: "Database error"
        });
      }

      if (!results || results.length === 0) {
        return res.json({
          success: false,
          message: "Invalid credentials"
        });
      }

      const user = results[0];

      /* ======================
         REDIRECT URL LOGIC
      ====================== */
      const FRONTEND_BASE_URL = "https://pixeltruth.com/mis";

      const role = user.Role;
      const department = user.Department;

      let redirectUrl = `${FRONTEND_BASE_URL}/${department}/dashboard.html`;

      if (role === "HR") {
        redirectUrl = `${FRONTEND_BASE_URL}/HR/${department}/HR_dashboard.html`;
      } 
      else if (role === "Team_Lead") {
        redirectUrl = `${FRONTEND_BASE_URL}/TL/${department}/TL_dashboard.html`;
      }

      return res.json({
        success: true,
        redirectUrl,
        user: {
          User_Name: user.User_Name,
          User_Mail: user.User_Mail,
          Role: user.Role,
          Department: user.Department
        }
      });
    }
  );
});

/* ======================
   Server Start
====================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
