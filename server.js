import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
import express from "express";
import sql from "mssql";
import cors from "cors";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import mammoth from "mammoth";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerDemandRoutes } from "./routes/demandRoutes.js";
import { registerDataRoutes } from "./routes/dataRoutes.js";

import paymentRoutes from "./routes/payments.route.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/payments", paymentRoutes);

const DEMAND_TEMPLATE_PATH = path.join(
  __dirname,
  "PPA_Lease_Renewal_Template.docx",
);
const DEMAND_NOTES_DIR = path.join(__dirname, "generated-demand-notes");
const DEMAND_TEMPLATE_RENDER_SCRIPT = path.join(
  __dirname,
  "scripts",
  "render-demand-note.ps1",
);

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_ISSUER = process.env.JWT_ISSUER || "ppa-lms-api";
const ACCESS_TOKEN_TTL = process.env.JWT_ACCESS_TTL || "8h";
const ACCESS_TOKEN_REMEMBER_TTL = process.env.JWT_ACCESS_TTL_REMEMBER || "7d";
const ALLOWED_ROLES = new Set(["User", "Manager", "Admin"]);
const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED_ATTEMPTS || 5);
const BLOCK_WINDOW_MS = Number(
  process.env.AUTH_BLOCK_WINDOW_MS || 15 * 60 * 1000,
);
const BLOCK_DURATION_MS = Number(
  process.env.AUTH_BLOCK_DURATION_MS || 15 * 60 * 1000,
);

if (!JWT_SECRET) {
  console.warn(
    "Warning: JWT_SECRET is not set. Set JWT_SECRET in .env before using authentication in production.",
  );
}

const dbConfig = {
  user: "sa",
  password: "Gklg2401",
  server: "GOKUL",
  database: "LeaseMgmtDB",
  port: 1433,
  options: {
    trustServerCertificate: true,
  },
};

let pool;
async function getPool() {
  if (!pool) pool = await sql.connect(dbConfig);
  return pool;
}

const loginAttemptState = new Map();

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

async function resolveLesseeByUsername(p, username) {
  const usernameNormalized = normalizeUsername(username);
  if (!usernameNormalized) return null;

  const result = await p
    .request()
    .input("usernameNormalized", sql.NVarChar(320), usernameNormalized).query(`
      SELECT TOP 1
        l.LesseeID,
        l.LesseeName,
        l.EmailID
      FROM dbo.Lessees l
      WHERE LOWER(LTRIM(RTRIM(ISNULL(l.EmailID, '')))) = @usernameNormalized
    `);

  return result.recordset[0] || null;
}

function sanitizeFileNamePart(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "");
  return cleaned || "DemandNote";
}

function execFile(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `${file} exited with code ${code}`));
    });
  });
}

let demandInfraPromise;
async function ensureDemandNoteInfrastructure() {
  if (!demandInfraPromise) {
    demandInfraPromise = (async () => {
      const p = await getPool();
      await p.request().query(`
        IF OBJECT_ID('dbo.DemandNotes', 'U') IS NULL
        BEGIN
          CREATE TABLE dbo.DemandNotes (
            DemandNoteID INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
            DemandID NVARCHAR(50) NULL,
            TransactionID NVARCHAR(50) NULL,
            LesseeID INT NOT NULL,
            LeaseID INT NULL,
            GeneratedByUserID INT NOT NULL,
            GeneratedAt DATETIME2 NOT NULL CONSTRAINT DF_DemandNotes_GeneratedAt DEFAULT SYSUTCDATETIME(),
            DueDate DATE NULL,
            Amount DECIMAL(18,2) NULL,
            Description NVARCHAR(1000) NULL,
            LandType NVARCHAR(100) NULL,
            DocumentPath NVARCHAR(500) NOT NULL,
            DocumentFileName NVARCHAR(260) NOT NULL,
            Status NVARCHAR(20) NOT NULL CONSTRAINT DF_DemandNotes_Status DEFAULT 'Generated',
            PaymentStatus NVARCHAR(20) NOT NULL CONSTRAINT DF_DemandNotes_PaymentStatus DEFAULT 'Not Paid',
            IssuedByUserID INT NULL,
            IssuedAt DATETIME2 NULL,
            RejectedByUserID INT NULL,
            RejectedAt DATETIME2 NULL,
            AdminRemarks NVARCHAR(500) NULL,
            CONSTRAINT FK_DemandNotes_Lessees FOREIGN KEY (LesseeID) REFERENCES dbo.Lessees(LesseeID),
            CONSTRAINT FK_DemandNotes_LeaseDetails FOREIGN KEY (LeaseID) REFERENCES dbo.LeaseDetails(LeaseID),
            CONSTRAINT FK_DemandNotes_GeneratedBy FOREIGN KEY (GeneratedByUserID) REFERENCES dbo.Users(UserID),
            CONSTRAINT FK_DemandNotes_IssuedBy FOREIGN KEY (IssuedByUserID) REFERENCES dbo.Users(UserID),
            CONSTRAINT FK_DemandNotes_RejectedBy FOREIGN KEY (RejectedByUserID) REFERENCES dbo.Users(UserID)
          );
        END

        IF COL_LENGTH('dbo.DemandNotes', 'LandType') IS NULL
        BEGIN
          ALTER TABLE dbo.DemandNotes ADD LandType NVARCHAR(100) NULL;
        END

        IF COL_LENGTH('dbo.DemandNotes', 'DemandID') IS NULL
        BEGIN
          ALTER TABLE dbo.DemandNotes ADD DemandID NVARCHAR(50) NULL;
        END

        IF COL_LENGTH('dbo.DemandNotes', 'TransactionID') IS NULL
        BEGIN
          ALTER TABLE dbo.DemandNotes ADD TransactionID NVARCHAR(50) NULL;
        END

        IF COL_LENGTH('dbo.DemandNotes', 'PaymentStatus') IS NULL
        BEGIN
          ALTER TABLE dbo.DemandNotes
          ADD PaymentStatus NVARCHAR(20) NOT NULL
          CONSTRAINT DF_DemandNotes_PaymentStatus DEFAULT 'Not Paid';
        END

        UPDATE dbo.DemandNotes
        SET
          DemandID = CASE
            WHEN DemandID IS NULL OR LTRIM(RTRIM(DemandID)) = '' THEN CONCAT('DM-', CAST(DemandNoteID AS VARCHAR(30)))
            ELSE DemandID
          END,
          TransactionID = CASE
            WHEN TransactionID IS NULL OR LTRIM(RTRIM(TransactionID)) = '' THEN CONCAT('TS-', CAST(DemandNoteID AS VARCHAR(30)))
            ELSE TransactionID
          END
        WHERE DemandID IS NULL
          OR LTRIM(RTRIM(DemandID)) = ''
          OR TransactionID IS NULL
          OR LTRIM(RTRIM(TransactionID)) = '';
      `);
      await fs.mkdir(DEMAND_NOTES_DIR, { recursive: true });
    })();
  }
  return demandInfraPromise;
}

async function renderDemandNoteDocument({
  demandNoteId,
  fields,
  fileNameBase,
}) {
  await fs.mkdir(DEMAND_NOTES_DIR, { recursive: true });
  const safeBase = sanitizeFileNamePart(fileNameBase);
  const outputFileName = `${safeBase}.docx`;
  const outputPath = path.join(DEMAND_NOTES_DIR, outputFileName);
  const dataPath = path.join(
    DEMAND_NOTES_DIR,
    `DemandNote_${demandNoteId}.json`,
  );
  await fs.writeFile(dataPath, JSON.stringify(fields), "utf8");
  try {
    await execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      DEMAND_TEMPLATE_RENDER_SCRIPT,
      "-TemplatePath",
      DEMAND_TEMPLATE_PATH,
      "-OutputPath",
      outputPath,
      "-DataPath",
      dataPath,
    ]);
  } finally {
    await fs.rm(dataPath, { force: true });
  }
  return { outputPath, outputFileName };
}

async function renderDemandNotePreviewHtml({ fields, fileNameBase }) {
  await fs.mkdir(DEMAND_NOTES_DIR, { recursive: true });
  const previewId = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const safeBase = `${sanitizeFileNamePart(fileNameBase)}_Preview_${previewId}`;
  const outputPath = path.join(DEMAND_NOTES_DIR, `${safeBase}.docx`);
  const dataPath = path.join(DEMAND_NOTES_DIR, `${safeBase}.json`);
  await fs.writeFile(dataPath, JSON.stringify(fields), "utf8");

  try {
    await execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      DEMAND_TEMPLATE_RENDER_SCRIPT,
      "-TemplatePath",
      DEMAND_TEMPLATE_PATH,
      "-OutputPath",
      outputPath,
      "-DataPath",
      dataPath,
    ]);

    const result = await mammoth.convertToHtml({ path: outputPath });
    return { html: result.value || "" };
  } finally {
    await fs.rm(dataPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
}

function hashPassword(
  plainPassword,
  saltHex = crypto.randomBytes(16).toString("hex"),
) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keyLen = 64;
  const derived = crypto.scryptSync(
    plainPassword,
    Buffer.from(saltHex, "hex"),
    keyLen,
    {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    },
  );
  return `scrypt$${N}$${r}$${p}$${saltHex}$${derived.toString("hex")}`;
}

function verifyPassword(plainPassword, storedHash) {
  if (!storedHash || typeof storedHash !== "string") return false;
  const [algo, nValue, rValue, pValue, saltHex, hashHex] =
    storedHash.split("$");
  if (
    algo !== "scrypt" ||
    !nValue ||
    !rValue ||
    !pValue ||
    !saltHex ||
    !hashHex
  )
    return false;

  const N = Number(nValue);
  const r = Number(rValue);
  const p = Number(pValue);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p))
    return false;

  const derived = crypto.scryptSync(
    plainPassword,
    Buffer.from(saltHex, "hex"),
    Buffer.from(hashHex, "hex").length,
    {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    },
  );

  return crypto.timingSafeEqual(derived, Buffer.from(hashHex, "hex"));
}

function issueAccessToken(user, rememberMe = false) {
  const payload = {
    sub: user.userId,
    username: user.username,
    role: user.role,
  };
  return jwt.sign(payload, JWT_SECRET, {
    issuer: JWT_ISSUER,
    expiresIn: rememberMe ? ACCESS_TOKEN_REMEMBER_TTL : ACCESS_TOKEN_TTL,
  });
}

function getAttemptKey(req, usernameNormalized) {
  const ip =
    req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  return `${usernameNormalized}:${ip}`;
}

function isBlockedAttempt(attempt) {
  return Boolean(attempt?.blockedUntil && attempt.blockedUntil > Date.now());
}

function registerFailedAttempt(key) {
  const now = Date.now();
  const current = loginAttemptState.get(key);
  if (!current || now - current.firstAttemptAt > BLOCK_WINDOW_MS) {
    loginAttemptState.set(key, {
      count: 1,
      firstAttemptAt: now,
      blockedUntil: null,
    });
    return;
  }

  const nextCount = current.count + 1;
  const blockedUntil =
    nextCount >= MAX_FAILED_ATTEMPTS ? now + BLOCK_DURATION_MS : null;
  loginAttemptState.set(key, {
    count: nextCount,
    firstAttemptAt: current.firstAttemptAt,
    blockedUntil,
  });
}

function clearFailedAttempts(key) {
  loginAttemptState.delete(key);
}

async function recordAuthEvent({
  userId = null,
  usernameAttempt = null,
  actionType,
  status,
  reason = null,
  ipAddress = null,
  userAgent = null,
}) {
  try {
    const p = await getPool();
    await p
      .request()
      .input("userId", sql.Int, userId)
      .input("usernameAttempt", sql.NVarChar(120), usernameAttempt)
      .input("actionType", sql.NVarChar(30), actionType)
      .input("status", sql.NVarChar(20), status)
      .input("reason", sql.NVarChar(300), reason)
      .input("ipAddress", sql.NVarChar(60), ipAddress)
      .input("userAgent", sql.NVarChar(300), userAgent).query(`
        INSERT INTO dbo.AuthAuditLogs
          (UserID, UsernameAttempt, ActionType, Status, Reason, IPAddress, UserAgent)
        VALUES
          (@userId, @usernameAttempt, @actionType, @status, @reason, @ipAddress, @userAgent)
      `);
  } catch (err) {
    console.error("Auth audit log error:", err.message);
  }
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ error: "Missing or invalid authorization token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: JWT_ISSUER });
    req.user = {
      userId: Number(payload.sub),
      username: payload.username,
      role: payload.role,
    };
    next();
  } catch {
    return res.status(401).json({ error: "Token is invalid or expired" });
  }
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Access denied for this role" });
    }
    next();
  };
}

app.get("/", (req, res) => res.send("Server is up"));

app.get("/db-test", async (req, res) => {
  try {
    const p = await getPool();
    const result = await p.request().query("SELECT name FROM sys.tables");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const sharedDeps = {
  app,
  fs,
  sql,
  JWT_SECRET,
  ALLOWED_ROLES,
  loginAttemptState,
  getPool,
  normalizeUsername,
  resolveLesseeByUsername,
  sanitizeFileNamePart,
  ensureDemandNoteInfrastructure,
  renderDemandNoteDocument,
  renderDemandNotePreviewHtml,
  hashPassword,
  verifyPassword,
  issueAccessToken,
  getAttemptKey,
  isBlockedAttempt,
  registerFailedAttempt,
  clearFailedAttempts,
  recordAuthEvent,
  authenticateToken,
  authorizeRoles,
};

registerAuthRoutes(app, sharedDeps);
registerDemandRoutes(app, sharedDeps);
registerDataRoutes(app, sharedDeps);

app.listen(process.env.PORT || 5000, () => {
  console.log(`API running on port ${process.env.PORT || 5000}`);
});
