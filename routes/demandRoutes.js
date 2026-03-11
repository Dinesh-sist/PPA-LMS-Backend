import { sendDemandNoteApprovedEmail } from "../utils/Mailer.js";

export function registerDemandRoutes(app, deps) {
  const {
    sql,
    fs,
    getPool,
    authenticateToken,
    authorizeRoles,
    ensureDemandNoteInfrastructure,
    renderDemandNoteDocument,
    renderDemandNotePreviewHtml,
    resolveLesseeByUsername,
    sanitizeFileNamePart,
  } = deps;

  function normalizeLeaseId(value) {
    if (value === null || value === undefined) return null;
    const leaseId = String(value).trim();
    if (!leaseId) return null;
    return leaseId.length <= 20 ? leaseId : null;
  }

  function normalizeLandType(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (raw === "lease" || raw === "market" || raw === "license") return raw;
    return "lease";
  }

  async function resolveDemandBaseRecord({ lesseeId, leaseId }) {
    const p = await getPool();
    const baseResult = await p
      .request()
      .input("lesseeId", sql.Int, lesseeId)
      .input("leaseId", sql.NVarChar(20), leaseId)
      .query(`
        SELECT
          l.LesseeID,
          l.LesseeName,
          l.Address,
          l.EmailID,
          l.ContactNo,
          c.CategoryName,
          ld.LeaseID,
          ld.TotalArea,
          ld.DateFrom,
          ld.DateTo
        FROM dbo.Lessees l
        LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
        INNER JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
        WHERE l.LesseeID = @lesseeId
          AND CONVERT(VARCHAR(20), ld.LeaseID) = @leaseId
      `);
    return { p, base: baseResult.recordset[0] };
  }

  function resolveDemandFileUserName(base) {
    return String(base?.LesseeName || "DemandNote").trim();
  }

  function buildDemandFields({ base, dueDate, amount, description }) {
    return {
      organisationName: base.LesseeName || "",
      departmentName: "",
      addressLine1: base.Address || "",
      cityPin: "",
      purposeDescription: description || "",
      areaValue: base.TotalArea || "",
      fromDate: base.DateFrom ? String(base.DateFrom).slice(0, 10) : "",
      toDate: base.DateTo ? String(base.DateTo).slice(0, 10) : "",
      dueDate: dueDate || "",
      amount: amount === null ? "" : amount.toFixed(2),
      contactNo: base.ContactNo || "",
      emailId: base.EmailID || "",
    };
  }

  app.get("/api/DemandNotes", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const p = await getPool();
      const result = await p.request().query(`
        SELECT
          d.DemandNoteID,
          d.LeaseID,
          l.LesseeID AS UserID,
          l.LesseeName AS name,
          l.LandType,
          COALESCE(d.LandType, c.CategoryName, CAST('' AS VARCHAR(100))) AS type,
          COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS land,
          CASE
            WHEN ld.DateFrom IS NOT NULL
              OR ld.DateTo IS NOT NULL
              THEN CONCAT(
                CONVERT(VARCHAR(10), ld.DateFrom, 23),
                ' to ',
                CONVERT(VARCHAR(10), ld.DateTo, 23)
              )
            ELSE ''
          END AS leaseTenure,
          d.DueDate AS dueDate,
          d.GeneratedAt AS demandGenerationDate,
          d.Status AS DemandStatus,
          d.PaymentStatus,
          d.Amount,
          d.Description,
          d.DocumentFileName,
          d.AdminRemarks,
          CONCAT('/api/demand-notes/', d.DemandNoteID, '/download') AS DownloadPath
        FROM dbo.DemandNotes d
        INNER JOIN dbo.Lessees l ON l.LesseeID = d.LesseeID
        LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
        LEFT JOIN dbo.LeaseDetails ld ON CONVERT(VARCHAR(20), ld.LeaseID) = CONVERT(VARCHAR(20), d.LeaseID)
        ORDER BY d.GeneratedAt DESC, d.DemandNoteID DESC
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.post("/api/demand-notes/generate", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const p = await getPool();
      const lesseeId = Number(req.body?.lesseeId);
      const leaseId = normalizeLeaseId(req.body?.leaseId);
      const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
      const amountRaw = req.body?.amount;
      const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === "" ? null : Number(amountRaw);
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const landTypeInput = req.body?.landType ? String(req.body.landType).trim() : null;
      const normalizedLandType = normalizeLandType(landTypeInput);

      if (!Number.isInteger(lesseeId) || lesseeId <= 0) {
        return res.status(400).json({ error: "Valid lesseeId is required" });
      }
      if (leaseId === null) {
        return res.status(400).json({ error: "leaseId is required and must be a non-empty string up to 20 characters" });
      }
      if (amount !== null && !Number.isFinite(amount)) {
        return res.status(400).json({ error: "Amount must be numeric" });
      }

      const { base } = await resolveDemandBaseRecord({ lesseeId, leaseId });
      if (!base) {
        return res.status(404).json({ error: "Lessee/lease record not found" });
      }

      const insertResult = await p
        .request()
        .input("lesseeId", sql.Int, lesseeId)
        .input("leaseId", sql.NVarChar(20), normalizeLeaseId(base.LeaseID))
        .input("generatedByUserId", sql.Int, req.user.userId)
        .input("dueDate", sql.Date, dueDate)
        .input("amount", sql.Decimal(18, 2), amount)
        .input("description", sql.NVarChar(1000), description)
        .input("landType", sql.NVarChar(100), normalizedLandType)
        .input("documentPath", sql.NVarChar(500), "")
        .input("documentFileName", sql.NVarChar(260), "")
        .query(`
          INSERT INTO dbo.DemandNotes
            (LesseeID, LeaseID, GeneratedByUserID, DueDate, Amount, Description, LandType, DocumentPath, DocumentFileName, Status, PaymentStatus)
          OUTPUT INSERTED.DemandNoteID
          VALUES
            (@lesseeId, @leaseId, @generatedByUserId, @dueDate, @amount, @description, @landType, @documentPath, @documentFileName, 'Generated', 'Not Paid')
        `);

      const demandNoteId = Number(insertResult.recordset[0]?.DemandNoteID);
      if (!demandNoteId) {
        return res.status(500).json({ error: "Failed to create demand note record" });
      }
      await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .query(`
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
          WHERE DemandNoteID = @demandNoteId
        `);

      try {
        const demandFileUserName = resolveDemandFileUserName(base);
        const { outputPath, outputFileName } = await renderDemandNoteDocument({
          demandNoteId,
          fileNameBase: `${demandFileUserName}_Demand_note_${demandNoteId}`,
          fields: buildDemandFields({ base, dueDate, amount, description }),
        });

        await p
          .request()
          .input("demandNoteId", sql.Int, demandNoteId)
          .input("documentPath", sql.NVarChar(500), outputPath)
          .input("documentFileName", sql.NVarChar(260), outputFileName)
          .query(`
            UPDATE dbo.DemandNotes
            SET DocumentPath = @documentPath,
                DocumentFileName = @documentFileName
            WHERE DemandNoteID = @demandNoteId
          `);
      } catch (renderErr) {
        await p.request().input("demandNoteId", sql.Int, demandNoteId).query("DELETE FROM dbo.DemandNotes WHERE DemandNoteID = @demandNoteId");
        throw renderErr;
      }

      return res.json({ success: true, demandNoteId });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Demand note generation failed" });
    }
  });

  app.post("/api/demand-notes/preview", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const lesseeId = Number(req.body?.lesseeId);
      const leaseId = normalizeLeaseId(req.body?.leaseId);
      const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
      const amountRaw = req.body?.amount;
      const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === "" ? null : Number(amountRaw);
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const landTypeInput = req.body?.landType ? String(req.body.landType).trim() : null;
      void landTypeInput;

      if (!Number.isInteger(lesseeId) || lesseeId <= 0) {
        return res.status(400).json({ error: "Valid lesseeId is required" });
      }
      if (leaseId === null) {
        return res.status(400).json({ error: "leaseId is required and must be a non-empty string up to 20 characters" });
      }
      if (amount !== null && !Number.isFinite(amount)) {
        return res.status(400).json({ error: "Amount must be numeric" });
      }

      const { base } = await resolveDemandBaseRecord({ lesseeId, leaseId });
      if (!base) {
        return res.status(404).json({ error: "Lessee/lease record not found" });
      }

      const preview = await renderDemandNotePreviewHtml({
        fileNameBase: `${resolveDemandFileUserName(base)}_Demand_note_Preview`,
        fields: buildDemandFields({ base, dueDate, amount, description }),
      });
      return res.json(preview);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Demand note preview failed" });
    }
  });

  app.post("/api/demand-notes/:id/issue", authenticateToken, authorizeRoles("Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const demandNoteId = Number(req.params.id);
      if (!Number.isInteger(demandNoteId) || demandNoteId <= 0) {
        return res.status(400).json({ error: "Invalid demand note id" });
      }

      const p = await getPool();

      const fetchResult = await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .query(`
          SELECT
            d.DemandNoteID,
            d.DueDate,
            d.Amount,
            d.Status,
            d.DocumentPath,
            d.DocumentFileName,
            l.LesseeName,
            l.EmailID
          FROM dbo.DemandNotes d
          INNER JOIN dbo.Lessees l ON l.LesseeID = d.LesseeID
          WHERE d.DemandNoteID = @demandNoteId
        `);

      const noteRow = fetchResult.recordset[0];
      if (!noteRow) {
        return res.status(404).json({ error: "Demand note not found" });
      }

      const result = await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .input("issuedByUserId", sql.Int, req.user.userId)
        .query(`
          UPDATE dbo.DemandNotes
          SET
            Status = 'Issued',
            DemandID = CASE
              WHEN DemandID IS NULL OR LTRIM(RTRIM(DemandID)) = '' THEN CONCAT('DM-', CAST(DemandNoteID AS VARCHAR(30)))
              ELSE DemandID
            END,
            TransactionID = CASE
              WHEN TransactionID IS NULL OR LTRIM(RTRIM(TransactionID)) = '' THEN CONCAT('TS-', CAST(DemandNoteID AS VARCHAR(30)))
              ELSE TransactionID
            END,
            PaymentStatus = COALESCE(PaymentStatus, 'Not Paid'),
            IssuedByUserID = @issuedByUserId,
            IssuedAt = SYSUTCDATETIME(),
            RejectedByUserID = NULL,
            RejectedAt = NULL,
            AdminRemarks = NULL
          WHERE DemandNoteID = @demandNoteId
            AND Status = 'Generated'
        `);

      if ((result.rowsAffected?.[0] || 0) === 0) {
        return res.status(400).json({ error: "Demand note is not in Generated status" });
      }

      if (noteRow.EmailID) {
        sendDemandNoteApprovedEmail({
          to: noteRow.EmailID,
          lesseeName: noteRow.LesseeName,
          demandNoteId,
          dueDate: noteRow.DueDate,
          amount: noteRow.Amount,
          documentPath: noteRow.DocumentPath,
          documentFileName: noteRow.DocumentFileName,
        }).catch((err) => console.error("Email send failed:", err.message));
      }

      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Issue action failed" });
    }
  });

  app.post("/api/demand-notes/:id/reject", authenticateToken, authorizeRoles("Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const demandNoteId = Number(req.params.id);
      const reason = req.body?.reason ? String(req.body.reason).trim() : null;
      if (!Number.isInteger(demandNoteId) || demandNoteId <= 0) {
        return res.status(400).json({ error: "Invalid demand note id" });
      }

      const p = await getPool();
      const result = await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .input("rejectedByUserId", sql.Int, req.user.userId)
        .input("reason", sql.NVarChar(500), reason)
        .query(`
          UPDATE dbo.DemandNotes
          SET
            Status = 'Rejected',
            RejectedByUserID = @rejectedByUserId,
            RejectedAt = SYSUTCDATETIME(),
            AdminRemarks = @reason,
            IssuedByUserID = NULL,
            IssuedAt = NULL
          WHERE DemandNoteID = @demandNoteId
            AND Status = 'Generated'
        `);

      if ((result.rowsAffected?.[0] || 0) === 0) {
        return res.status(400).json({ error: "Demand note is not in Generated status" });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Reject action failed" });
    }
  });

  app.post("/api/demand-notes/:id/mark-paid", authenticateToken, authorizeRoles("User", "Admin"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const demandNoteId = Number(req.params.id);
      if (!Number.isInteger(demandNoteId) || demandNoteId <= 0) {
        return res.status(400).json({ error: "Invalid demand note id" });
      }

      const p = await getPool();
      let lesseeId = null;
      if (req.user?.role === "User") {
        const ownLessee = await resolveLesseeByUsername(p, req.user.username);
        if (!ownLessee?.LesseeID) {
          return res.status(403).json({ error: "Access denied for this demand note" });
        }
        lesseeId = Number(ownLessee.LesseeID);
      }

      const updateDemandResult = await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .input("lesseeId", sql.Int, lesseeId)
        .query(`
          UPDATE d
          SET d.PaymentStatus = 'Paid'
          FROM dbo.DemandNotes d
          WHERE d.DemandNoteID = @demandNoteId
            AND d.Status = 'Issued'
            AND (@lesseeId IS NULL OR d.LesseeID = @lesseeId)
        `);

      if ((updateDemandResult.rowsAffected?.[0] || 0) === 0) {
        return res.status(404).json({ error: "Issued demand note not found for this user" });
      }

      await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .input("lesseeId", sql.Int, lesseeId)
        .query(`
          UPDATE ld
          SET ld.PaymentStatus = 'Paid'
          FROM dbo.LeaseDetails ld
          INNER JOIN dbo.DemandNotes d ON CONVERT(VARCHAR(20), d.LeaseID) = CONVERT(VARCHAR(20), ld.LeaseID)
          WHERE d.DemandNoteID = @demandNoteId
            AND (@lesseeId IS NULL OR d.LesseeID = @lesseeId)
        `);

      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update payment status" });
    }
  });

  app.get("/api/demand-notes/:id/download", authenticateToken, async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const demandNoteId = Number(req.params.id);
      if (!Number.isInteger(demandNoteId) || demandNoteId <= 0) {
        return res.status(400).json({ error: "Invalid demand note id" });
      }

      const p = await getPool();
      const result = await p
        .request()
        .input("demandNoteId", sql.Int, demandNoteId)
        .query(`
          SELECT
            d.DemandNoteID,
            d.LesseeID,
            d.DocumentPath,
            d.DocumentFileName,
            d.Status,
            l.LesseeName
          FROM dbo.DemandNotes d
          INNER JOIN dbo.Lessees l ON l.LesseeID = d.LesseeID
          WHERE d.DemandNoteID = @demandNoteId
        `);
      const row = result.recordset[0];
      if (!row) {
        return res.status(404).json({ error: "Demand note not found" });
      }

      if (req.user?.role === "User") {
        const ownLessee = await resolveLesseeByUsername(p, req.user.username);
        if (!ownLessee?.LesseeID || Number(ownLessee.LesseeID) !== Number(row.LesseeID) || row.Status !== "Issued") {
          return res.status(403).json({ error: "Access denied for this demand note" });
        }
      }

      try {
        await fs.access(row.DocumentPath);
      } catch {
        return res.status(404).json({ error: "Demand note file not found on server" });
      }

      const sourceName = String(row.DocumentFileName || row.DocumentPath || "");
      const extMatch = sourceName.match(/\.[a-z0-9]+$/i);
      const ext = extMatch ? extMatch[0] : ".pdf";
      const dynamicName = `${sanitizeFileNamePart(row.LesseeName)}_Demand_note_${row.DemandNoteID}${ext}`;
      return res.download(row.DocumentPath, dynamicName);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Demand note download failed" });
    }
  });
}
