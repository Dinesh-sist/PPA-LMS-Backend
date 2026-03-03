export function registerDataRoutes(app, deps) {
  const {
    sql,
    getPool,
    authenticateToken,
    authorizeRoles,
    resolveLesseeByUsername,
    ensureDemandNoteInfrastructure,
  } = deps;

  const LAND_DATA_CONFIG = {
    lease: {
      idColumn: "LeaseID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.LeaseData",
      visibleColumns: ["LeaseID", "Area__in_S"],
    },
    market: {
      idColumn: "MarketID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.MarketData",
      visibleColumns: ["MarketID", "Refname"],
    },
    license: {
      idColumn: "LicenseID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.LicenseData",
      visibleColumns: ["LicenseID", "AREA_ALLOT"],
    },
  };

  function getLandConfig(typeValue) {
    const rawType = String(typeValue || "lease").trim().toLowerCase();
    return LAND_DATA_CONFIG[rawType] ? { type: rawType, ...LAND_DATA_CONFIG[rawType] } : { type: "lease", ...LAND_DATA_CONFIG.lease };
  }

  app.get("/api/LesseeFullView", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      const p = await getPool();
      const result = await p.request().query(`
        SELECT
          l.LesseeID AS UserID,
          l.LesseeID,
          l.LesseeName,
          c.CategoryName,
          l.IDNumber,
          l.ContactNo,
          l.Address,
          l.EmailID,
          ld.LeaseID,
          ld.AreaDivision,
          ld.TotalArea,
          ld.PaymentStatus,
          ld.PaymentStatus AS PaymentStatusCode,
          ld.DateFrom,
          ld.DateTo,
          ld.DateTo AS LeaseEndDate,
          COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
          COALESCE(c.CategoryName, CAST('' AS VARCHAR(100))) AS LandType
        FROM dbo.Lessees l
        LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
        LEFT JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
        ORDER BY l.LesseeID, ld.LeaseID
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.get("/api/LandData", authenticateToken, authorizeRoles("Manager", "Admin", "User"), async (req, res) => {
    try {
      const p = await getPool();
      const config = getLandConfig(req.query.type);
      const selectCols = config.visibleColumns.map((col) => `[${col}]`).join(", ");
      const result = await p.request().query(`
        SELECT
          [${config.objectIdColumn}] AS OBJECTID,
          [${config.idColumn}] AS RowID,
          ${selectCols}
        FROM ${config.tableName}
        ORDER BY [${config.idColumn}]
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.put("/api/LandData/:type/:id", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      const config = getLandConfig(req.params.type);
      const rowId = Number(req.params.id);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        return res.status(400).json({ error: "Invalid row id" });
      }

      const p = await getPool();
      const request = p.request().input("id", sql.Int, rowId);

      for (const col of config.visibleColumns) {
        request.input(col, sql.NVarChar(sql.MAX), req.body?.[col] ?? null);
      }

      const setClause = config.visibleColumns.map((col) => `[${col}] = @${col}`).join(", ");
      const updateResult = await request.query(`
        UPDATE ${config.tableName}
        SET ${setClause}
        WHERE [${config.idColumn}] = @id;
        SELECT @@ROWCOUNT AS affected;
      `);

      const affected = Number(updateResult.recordset?.[0]?.affected || 0);
      if (!affected) {
        return res.status(404).json({ error: "Record not found" });
      }

      const selectCols = config.visibleColumns.map((col) => `[${col}]`).join(", ");
      const updated = await p
        .request()
        .input("id", sql.Int, rowId)
        .query(`
          SELECT
            [${config.objectIdColumn}] AS OBJECTID,
            [${config.idColumn}] AS RowID,
            ${selectCols}
          FROM ${config.tableName}
          WHERE [${config.idColumn}] = @id
        `);

      res.json(updated.recordset?.[0] || null);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB update failed" });
    }
  });

  // app.delete("/api/LandData/:type/:id", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
  //   try {
  //     const config = getLandConfig(req.params.type);
  //     const rowId = Number(req.params.id);
  //     if (!Number.isInteger(rowId) || rowId <= 0) {
  //       return res.status(400).json({ error: "Invalid row id" });
  //     }
  //
  //     const p = await getPool();
  //     const result = await p
  //       .request()
  //       .input("id", sql.Int, rowId)
  //       .query(`
  //         DELETE FROM ${config.tableName}
  //         WHERE [${config.idColumn}] = @id;
  //         SELECT @@ROWCOUNT AS affected;
  //       `);
  //
  //     const affected = Number(result.recordset?.[0]?.affected || 0);
  //     if (!affected) {
  //       return res.status(404).json({ error: "Record not found" });
  //     }
  //
  //     res.json({ success: true });
  //   } catch (err) {
  //     console.error(err);
  //     res.status(500).json({ error: "DB delete failed" });
  //   }
  // });

  app.get("/api/EoiTable", authenticateToken, authorizeRoles("Manager", "Admin"), async (req, res) => {
    try {
      const p = await getPool();
      const result = await p.request().query(`
        SELECT
          ld.LeaseID AS EOIID,
          l.LesseeName AS EOIConsumerName,
          COALESCE(c.CategoryName, CAST('' AS VARCHAR(100))) AS EOILandType,
          COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS EOILandName,
          ld.DateFrom AS EOIAppliedDate,
          CAST('' AS VARCHAR(100)) AS EOIStatus
        FROM dbo.LeaseDetails ld
        INNER JOIN dbo.Lessees l ON l.LesseeID = ld.LesseeID
        LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
        ORDER BY ld.LeaseID
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.get("/api/UserProfile", authenticateToken, authorizeRoles("Manager", "Admin", "User"), async (req, res) => {
    try {
      const p = await getPool();
      let result;
      if (req.user?.role === "User") {
        const lessee = await resolveLesseeByUsername(p, req.user.username);
        if (!lessee?.LesseeID) {
          return res.json([]);
        }

        result = await p
          .request()
          .input("lesseeId", sql.Int, Number(lessee.LesseeID))
          .query(`
            SELECT
              l.LesseeName AS CompanyName,
              c.CategoryName AS OrganisationType,
              l.LesseeName AS AuthorityName,
              l.EmailID AS EmailId,
              l.Address,
              l.ContactNo AS Phone
            FROM dbo.Lessees l
            LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
            WHERE l.LesseeID = @lesseeId
          `);
      } else {
        result = await p.request().query(`
          SELECT
            l.LesseeName AS CompanyName,
            c.CategoryName AS OrganisationType,
            l.LesseeName AS AuthorityName,
            l.EmailID AS EmailId,
            l.Address,
            l.ContactNo AS Phone
          FROM dbo.Lessees l
          LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
          ORDER BY l.LesseeID
        `);
      }
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.get("/api/UserData", authenticateToken, authorizeRoles("Manager", "Admin", "User"), async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const p = await getPool();
      let result;
      if (req.user?.role === "User") {
        const lessee = await resolveLesseeByUsername(p, req.user.username);
        if (!lessee?.LesseeID) {
          return res.json([]);
        }

        result = await p
          .request()
          .input("lesseeId", sql.Int, Number(lessee.LesseeID))
          .query(`
            SELECT
              l.LesseeID AS UserID,
              l.LesseeID,
              l.LesseeName,
              c.CategoryName,
              l.IDNumber,
              l.ContactNo,
              l.Address,
              l.EmailID,
              ld.LeaseID,
              ld.AreaDivision,
              ld.TotalArea,
              ld.PaymentStatus,
              ld.PaymentStatus AS PaymentStatusCode,
              ld.DateFrom,
              ld.DateTo,
              COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
              COALESCE(dn.LandType, c.CategoryName, CAST('' AS VARCHAR(100))) AS LandType,
              COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
              dn.Amount AS OutstandingDue,
              dn.DemandNoteID,
              dn.Status AS DemandNoteStatus,
              dn.DocumentFileName,
              CASE
                WHEN dn.DemandNoteID IS NOT NULL THEN CONCAT('/api/demand-notes/', dn.DemandNoteID, '/download')
                ELSE ''
              END AS DemandNoteDownloadPath
            FROM dbo.Lessees l
            LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
            LEFT JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
            OUTER APPLY (
              SELECT TOP 1
                d.DemandNoteID,
                d.Amount,
                d.DueDate,
                d.Status,
                d.DocumentFileName,
                d.LandType
              FROM dbo.DemandNotes d
              WHERE d.LesseeID = l.LesseeID
                AND d.Status = 'Issued'
                AND (ld.LeaseID IS NULL OR d.LeaseID IS NULL OR d.LeaseID = ld.LeaseID)
              ORDER BY d.IssuedAt DESC, d.GeneratedAt DESC, d.DemandNoteID DESC
            ) dn
            WHERE l.LesseeID = @lesseeId
            ORDER BY l.LesseeID, ld.LeaseID
          `);
      } else {
        result = await p.request().query(`
          SELECT
            l.LesseeID AS UserID,
            l.LesseeID,
            l.LesseeName,
            c.CategoryName,
            l.IDNumber,
            l.ContactNo,
            l.Address,
            l.EmailID,
            ld.LeaseID,
            ld.AreaDivision,
            ld.TotalArea,
            ld.PaymentStatus,
            ld.PaymentStatus AS PaymentStatusCode,
            ld.DateFrom,
            ld.DateTo,
            COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
            COALESCE(dn.LandType, c.CategoryName, CAST('' AS VARCHAR(100))) AS LandType,
            COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
            dn.Amount AS OutstandingDue,
            dn.DemandNoteID,
            dn.Status AS DemandNoteStatus,
            dn.DocumentFileName,
            CASE
              WHEN dn.DemandNoteID IS NOT NULL THEN CONCAT('/api/demand-notes/', dn.DemandNoteID, '/download')
              ELSE ''
            END AS DemandNoteDownloadPath
          FROM dbo.Lessees l
          LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
          LEFT JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
          OUTER APPLY (
            SELECT TOP 1
              d.DemandNoteID,
              d.Amount,
              d.DueDate,
              d.Status,
              d.DocumentFileName,
              d.LandType
            FROM dbo.DemandNotes d
            WHERE d.LesseeID = l.LesseeID
              AND d.Status = 'Issued'
              AND (ld.LeaseID IS NULL OR d.LeaseID IS NULL OR d.LeaseID = ld.LeaseID)
            ORDER BY d.IssuedAt DESC, d.GeneratedAt DESC, d.DemandNoteID DESC
          ) dn
          ORDER BY l.LesseeID, ld.LeaseID
        `);
      }
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.get("/api/UserData/:userId", authenticateToken, async (req, res) => {
    try {
      await ensureDemandNoteInfrastructure();
      const p = await getPool();
      const requestedUserId = Number(req.params.userId);

      if (req.user?.role === "User") {
        const ownLessee = await resolveLesseeByUsername(p, req.user.username);
        const ownLesseeId = Number(ownLessee?.LesseeID || 0);
        if (!ownLesseeId || ownLesseeId !== requestedUserId) {
          return res.status(403).json({ error: "Access denied for this user record" });
        }
      }

      const result = await p
        .request()
        .input("userId", sql.Int, requestedUserId)
        .query(`
          SELECT
            l.LesseeID AS UserID,
            l.LesseeID,
            l.LesseeName,
            c.CategoryName,
            l.IDNumber,
            l.ContactNo,
            l.Address,
            l.EmailID,
            ld.LeaseID,
            ld.AreaDivision,
            ld.TotalArea,
            ld.PaymentStatus,
            ld.PaymentStatus AS PaymentStatusCode,
            ld.DateFrom,
            ld.DateTo,
            COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
            COALESCE(dn.LandType, c.CategoryName, CAST('' AS VARCHAR(100))) AS LandType,
            COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
            dn.Amount AS OutstandingDue,
            dn.DemandNoteID,
            dn.Status AS DemandNoteStatus,
            dn.DocumentFileName,
            CASE
              WHEN dn.DemandNoteID IS NOT NULL THEN CONCAT('/api/demand-notes/', dn.DemandNoteID, '/download')
              ELSE ''
            END AS DemandNoteDownloadPath
          FROM dbo.Lessees l
          LEFT JOIN dbo.Categories c ON c.CategoryID = l.CategoryID
          LEFT JOIN dbo.LeaseDetails ld ON ld.LesseeID = l.LesseeID
          OUTER APPLY (
            SELECT TOP 1
              d.DemandNoteID,
              d.Amount,
              d.DueDate,
              d.Status,
              d.DocumentFileName,
              d.LandType
            FROM dbo.DemandNotes d
            WHERE d.LesseeID = l.LesseeID
              AND d.Status = 'Issued'
              AND (ld.LeaseID IS NULL OR d.LeaseID IS NULL OR d.LeaseID = ld.LeaseID)
            ORDER BY d.IssuedAt DESC, d.GeneratedAt DESC, d.DemandNoteID DESC
          ) dn
          WHERE l.LesseeID = @userId
          ORDER BY l.LesseeID, ld.LeaseID
        `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });
}
