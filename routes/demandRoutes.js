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

  async function resolveDemandBaseRecord({ lesseeId, leaseId }) {
    const p = await getPool();
    const baseResult = await p
      .request()
      .input("lesseeId", sql.Int, lesseeId)
      .input("leaseId", sql.Int, leaseId)
      .query(`
        SELECT TOP 1
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
        LEFT JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
        WHERE l.LesseeID = @lesseeId
          AND (@leaseId IS NULL OR ld.LeaseID = @leaseId)
        ORDER BY CASE WHEN @leaseId IS NULL THEN ISNULL(ld.LeaseID, 2147483647) ELSE 0 END
      `);
    return { p, base: baseResult.recordset[0] };
  }

  async function resolveDemandFileUserName(base) {
    const emailNormalized = String(base?.EmailID || "").trim().toLowerCase();
    if (emailNormalized) {
      try {
        const p = await getPool();
        const userResult = await p
          .request()
          .input("usernameNormalized", sql.NVarChar(120), emailNormalized)
          .query(`
            SELECT TOP 1 u.Username
            FROM dbo.Users u
            WHERE u.UsernameNormalized = @usernameNormalized
          `);
        const matchedUsername = userResult.recordset[0]?.Username;
        if (matchedUsername) return String(matchedUsername).trim();
      } catch {
        // Fallback below if account lookup fails.
      }
      return emailNormalized;
    }
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
            WHEN ld.DateFrom IS NOT NULL OR ld.DateTo IS NOT NULL
              THEN CONCAT(CONVERT(VARCHAR(10), ld.DateFrom, 23), ' to ', CONVERT(VARCHAR(10), ld.DateTo, 23))
            ELSE ''
          END AS leaseTenure,
          COALESCE(d.DueDate, ld.DateTo) AS dueDate,
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
        LEFT JOIN dbo.LeaseDetails ld ON ld.LeaseID = d.LeaseID
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
      const leaseId = req.body?.leaseId === null || req.body?.leaseId === undefined ? null : Number(req.body.leaseId);
      const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
      const amountRaw = req.body?.amount;
      const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === "" ? null : Number(amountRaw);
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const normalizedLandType = "lease";

      if (!Number.isInteger(lesseeId) || lesseeId <= 0) {
        return res.status(400).json({ error: "Valid lesseeId is required" });
      }
      if (leaseId !== null && (!Number.isInteger(leaseId) || leaseId <= 0)) {
        return res.status(400).json({ error: "leaseId must be null or a positive integer" });
      }
      if (amount !== null && !Number.isFinite(amount)) {
        return res.status(400).json({ error: "Amount must be numeric" });
      }

      const { base } = await resolveDemandBaseRecord({ lesseeId, leaseId });
      if (!base) {
        return res.status(404).json({ error : "Lessee/lease record not found" });
      }

      const insertResult = await p
        .request()
        .input("lesseeId", sql.Int, lesseeId)
        .input("leaseId", sql.Int, base.LeaseID || null)
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
        const demandFileUserName = await resolveDemandFileUserName(base);
        const { outputPath, outputFileName } = await renderDemandNoteDocument({
          demandNoteId,
          fileNameBase: `${demandFileUserName}_DemandNote_${demandNoteId}`,
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
      const leaseId = req.body?.leaseId === null || req.body?.leaseId === undefined ? null : Number(req.body.leaseId);
      const dueDate = req.body?.dueDate ? String(req.body.dueDate) : null;
      const amountRaw = req.body?.amount;
      const amount = amountRaw === null || amountRaw === undefined || String(amountRaw).trim() === "" ? null : Number(amountRaw);
      const description = req.body?.description ? String(req.body.description).trim() : null;
      const landTypeInput = req.body?.landType ? String(req.body.landType).trim() : null;

      if (!Number.isInteger(lesseeId) || lesseeId <= 0) {
        return res.status(400).json({ error: "Valid lesseeId is required" });
      }
      if (leaseId !== null && (!Number.isInteger(leaseId) || leaseId <= 0)) {
        return res.status(400).json({ error: "leaseId must be null or a positive integer" });
      }
      if (amount !== null && !Number.isFinite(amount)) {
        return res.status(400).json({ error: "Amount must be numeric" });
      }

      const { base } = await resolveDemandBaseRecord({ lesseeId, leaseId });
      if (!base) {
        return res.status(404).json({ error: "Lessee/lease record not found" });
      }
      const demandFileUserName = await resolveDemandFileUserName(base);

      const preview = await renderDemandNotePreviewHtml({
        fileNameBase: `${demandFileUserName}_DemandNote_Preview`,
        fields: buildDemandFields({ base, dueDate, amount, description }),
      });

      return res.json({ html: preview.html || "" });
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
          INNER JOIN dbo.DemandNotes d ON d.LeaseID = ld.LeaseID
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
      const dynamicName = `${sanitizeFileNamePart(row.LesseeName)}_DemandNote_${row.DemandNoteID}.docx`;
      return res.download(row.DocumentPath, dynamicName);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Demand note download failed" });
    }
  });
}
