import http from "node:http";
import https from "node:https";
import proj4 from "proj4";
import wk from "wellknown";

const utm45n = "+proj=utm +zone=45 +datum=WGS84 +units=m +no_defs";
const wgs84 = "+proj=longlat +datum=WGS84 +no_defs";

function transformCoordinates(coords) {
  if (Array.isArray(coords[0])) {
    coords.forEach(transformCoordinates);
  } else {
    const [lng, lat] = proj4(utm45n, wgs84, [coords[0], coords[1]]);
    coords[0] = lng;
    coords[1] = lat;
  }
}

function requestJson(urlString, { rejectUnauthorized = true } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { accept: "application/json" },
        rejectUnauthorized: isHttps ? rejectUnauthorized : undefined,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const contentType = res.headers["content-type"] || "";
          resolve({
            status: res.statusCode || 0,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            contentType,
            body,
          });
        });
      },
    );

    req.on("error", reject);
    req.end();
  });
}

export function registerDataRoutes(app, deps) {

  const {
    sql,
    getPool,
    authenticateToken,
    authorizeRoles,
    resolveLesseeByUsername,
    ensureDemandNoteInfrastructure,
  } = deps;

  const GEOSERVER_BASE_URL =
    process.env.GEOSERVER_BASE_URL ||
    "https://ppa-lms.in/geoserver/Paradip/wms";
  const GEOSERVER_INSECURE_TLS =
    String(process.env.GEOSERVER_INSECURE_TLS || "")
      .trim()
      .toLowerCase() === "true";
  const ALLOWED_GEOSERVER_TYPES = new Set(["lease", "market", "license"]);

  const LAND_DATA_CONFIG = {
    lease: {
      idColumn: "LeaseID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.LeaseData",
      visibleColumns: ["LeaseID", "LandID", "Area__in_S", "Shape"],
    },
    market: {
      idColumn: "MarketID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.MarketData",
      visibleColumns: ["MarketID", "LandId", "Refname", "TotalRate", "Shape"],
    },
    license: {
      idColumn: "LicenseID",
      objectIdColumn: "OBJECTID",
      tableName: "dbo.LicenseData",
      visibleColumns: ["LicenseID", "LandID", "AREA_ALLOT", "Shape"],
    },
  };

  let eoiInfraPromise;
  async function ensureEoiInfrastructure() {
    if (!eoiInfraPromise) {
      eoiInfraPromise = (async () => {
        const p = await getPool();
        await p.request().query(`
          IF OBJECT_ID('dbo.EoiRequests', 'U') IS NULL
          BEGIN
            CREATE TABLE dbo.EoiRequests (
              EOIID INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
              RequestedByUserID INT NOT NULL,
              RequestedLesseeID INT NULL,
              EOIConsumerName NVARCHAR(200) NOT NULL,
              EOILandType NVARCHAR(40) NOT NULL,
              EOILandName NVARCHAR(200) NULL,
              ObjectID INT NULL,
              EOIAppliedDate DATETIME2 NOT NULL CONSTRAINT DF_EoiRequests_AppliedDate DEFAULT SYSUTCDATETIME(),
              EOIStatus NVARCHAR(40) NOT NULL CONSTRAINT DF_EoiRequests_Status DEFAULT 'Applied',
              CONSTRAINT FK_EoiRequests_Users FOREIGN KEY (RequestedByUserID) REFERENCES dbo.Users(UserID),
              CONSTRAINT FK_EoiRequests_Lessees FOREIGN KEY (RequestedLesseeID) REFERENCES dbo.Lessees(LesseeID)
            );
          END
        `);
      })();
    }
    return eoiInfraPromise;
  }



  function getLandConfig(typeValue) {
    const rawType = String(typeValue || "lease").trim().toLowerCase();
    return LAND_DATA_CONFIG[rawType] ? { type: rawType, ...LAND_DATA_CONFIG[rawType] } : { type: "lease", ...LAND_DATA_CONFIG.lease };
  }


  app.get("/api/map/wkt", authenticateToken, authorizeRoles("User", "Manager", "Admin"), async (req, res) => {
    try {
      const typeRaw = String(req.query?.type || "").trim().toLowerCase();
      const types = typeRaw
        ? [typeRaw]
        : ["lease", "market", "license"];

      if (types.some((t) => !ALLOWED_GEOSERVER_TYPES.has(t))) {
        return res.status(400).json({ error: "Invalid land type" });
      }

      const p = await getPool();
      const rows = [];

      for (const type of types) {
        const config = getLandConfig(type);
        const result = await p.request().query(`
          SELECT
            '${type}' AS LandType,
            [${config.objectIdColumn}] AS OBJECTID,
            [${config.visibleColumns[2]}] AS Area__in_S,
            [Shape].STAsText() AS Shape
          FROM ${config.tableName}
          WHERE [Shape] IS NOT NULL
        `);
        const recordset = result.recordset || [];
        for (const row of recordset) {
          let geometry = null;
          if (row.Shape) {
            try {
              geometry = wk.parse(row.Shape);
              if (geometry?.coordinates) {
                transformCoordinates(geometry.coordinates);
              }
            } catch (err) {
              console.error("WKT parse failed:", err);
            }
          }
          rows.push({
            ...row,
            Geometry: geometry,
          });
        }
      }

      if (!rows.length) {
        return res.status(404).json({ error: "No WKT data found" });
      }
      return res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch WKT data" });
    }
  });

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
          COALESCE(l.LandType, CAST('' AS VARCHAR(100))) AS LandType
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
          [${config.objectIdColumn}] AS RowID,
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

  // app.get("/api/geoserver/wfs", authenticateToken, authorizeRoles("User", "Manager", "Admin"), async (req, res) => {
  //   try {
  //     const typeRaw = String(req.query?.type || "").trim().toLowerCase();
  //     if (!ALLOWED_GEOSERVER_TYPES.has(typeRaw)) {
  //       return res.status(400).json({ error: "Invalid land type" });
  //     }

  //     const objectIdRaw = req.query?.objectId;
  //     const objectId = Number(objectIdRaw);
  //     const url = new URL(GEOSERVER_BASE_URL);
  //     url.searchParams.set("SERVICE", "WFS");
  //     url.searchParams.set("VERSION", "1.0.0");
  //     url.searchParams.set("REQUEST", "GetFeature");
  //     url.searchParams.set("TYPENAME", `Paradip:${typeRaw}`);
  //     url.searchParams.set("OUTPUTFORMAT", "application/json");
  //     url.searchParams.set("SRSNAME", "EPSG:4326");
  //     if (Number.isInteger(objectId) && objectId > 0) {
  //       url.searchParams.set("CQL_FILTER", `OBJECTID=${objectId}`);
  //     }

  //     const upstream = await requestJson(url.toString(), {
  //       rejectUnauthorized: !GEOSERVER_INSECURE_TLS,
  //     });

  //     const contentType = upstream.contentType || "";
  //     if (!upstream.ok) {
  //       let errorBody = upstream.body;
  //       if (contentType.includes("application/json")) {
  //         try {
  //           errorBody = JSON.parse(upstream.body);
  //         } catch {
  //           // keep raw body
  //         }
  //       }
  //       return res.status(upstream.status || 502).json({
  //         error: "GeoServer request failed",
  //         details: errorBody,
  //       });
  //     }

  //     if (contentType.includes("application/json")) {
  //       try {
  //         const data = JSON.parse(upstream.body || "null");
  //         return res.status(upstream.status || 200).json(data);
  //       } catch {
  //         return res.status(502).json({
  //           error: "Invalid GeoServer JSON",
  //           details: upstream.body,
  //         });
  //       }
  //     }

  //     return res.status(502).json({
  //       error: "Unexpected GeoServer response",
  //       details: upstream.body,
  //     });
  //   } catch (err) {
  //     console.error("GeoServer proxy error:", err);
  //     res.status(502).json({ error: "GeoServer proxy failed" });
  //   }
  // });

  // app.get("/api/geoserver/wms-info", authenticateToken, authorizeRoles("User", "Manager", "Admin"), async (req, res) => {
  //   try {
  //     const layersRaw = String(req.query?.layers || "").trim();
  //     const queryLayersRaw = String(req.query?.queryLayers || "").trim();
  //     const bboxRaw = String(req.query?.bbox || "").trim();
  //     const widthRaw = String(req.query?.width || "").trim();
  //     const heightRaw = String(req.query?.height || "").trim();
  //     const xRaw = String(req.query?.x || "").trim();
  //     const yRaw = String(req.query?.y || "").trim();
  //     const srsRaw = String(req.query?.srs || "EPSG:4326").trim();

  //     const isLayerList = (val) => /^[A-Za-z0-9:_,-]+$/.test(val);
  //     const isBbox = (val) => /^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(val);
  //     const isInt = (val) => /^\d+$/.test(val);
  //     const isSrs = (val) => /^EPSG:\d+$/.test(val);

  //     if (!layersRaw || !queryLayersRaw || !bboxRaw || !widthRaw || !heightRaw || !xRaw || !yRaw) {
  //       return res.status(400).json({ error: "Missing required parameters" });
  //     }
  //     if (!isLayerList(layersRaw) || !isLayerList(queryLayersRaw)) {
  //       return res.status(400).json({ error: "Invalid layers" });
  //     }
  //     if (!isBbox(bboxRaw)) {
  //       return res.status(400).json({ error: "Invalid bbox" });
  //     }
  //     if (!isInt(widthRaw) || !isInt(heightRaw) || !isInt(xRaw) || !isInt(yRaw)) {
  //       return res.status(400).json({ error: "Invalid size or point" });
  //     }
  //     if (!isSrs(srsRaw)) {
  //       return res.status(400).json({ error: "Invalid SRS" });
  //     }

  //     const url = new URL(GEOSERVER_BASE_URL);
  //     url.searchParams.set("SERVICE", "WMS");
  //     url.searchParams.set("VERSION", "1.1.1");
  //     url.searchParams.set("REQUEST", "GetFeatureInfo");
  //     url.searchParams.set("LAYERS", layersRaw);
  //     url.searchParams.set("QUERY_LAYERS", queryLayersRaw);
  //     url.searchParams.set("STYLES", "");
  //     url.searchParams.set("BBOX", bboxRaw);
  //     url.searchParams.set("FEATURE_COUNT", "50");
  //     url.searchParams.set("HEIGHT", heightRaw);
  //     url.searchParams.set("WIDTH", widthRaw);
  //     url.searchParams.set("FORMAT", "image/png");
  //     url.searchParams.set("INFO_FORMAT", "application/json");
  //     url.searchParams.set("SRS", srsRaw);
  //     url.searchParams.set("X", xRaw);
  //     url.searchParams.set("Y", yRaw);

  //     const upstream = await requestJson(url.toString(), {
  //       rejectUnauthorized: !GEOSERVER_INSECURE_TLS,
  //     });

  //     const contentType = upstream.contentType || "";
  //     if (!upstream.ok) {
  //       let errorBody = upstream.body;
  //       if (contentType.includes("application/json")) {
  //         try {
  //           errorBody = JSON.parse(upstream.body);
  //         } catch {
  //           // keep raw body
  //         }
  //       }
  //       return res.status(upstream.status || 502).json({
  //         error: "GeoServer request failed",
  //         details: errorBody,
  //       });
  //     }

  //     if (contentType.includes("application/json")) {
  //       try {
  //         const data = JSON.parse(upstream.body || "null");
  //         return res.status(upstream.status || 200).json(data);
  //       } catch {
  //         return res.status(502).json({
  //           error: "Invalid GeoServer JSON",
  //           details: upstream.body,
  //         });
  //       }
  //     }

  //     return res.status(502).json({
  //       error: "Unexpected GeoServer response",
  //       details: upstream.body,
  //     });
  //   } catch (err) {
  //     console.error("GeoServer WMS proxy error:", err);
  //     res.status(502).json({ error: "GeoServer proxy failed" });
  //   }
  // });

  app.put("/api/LandData/:type/:id", authenticateToken, authorizeRoles("User","Manager", "Admin"), async (req, res) => {
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
        WHERE [${config.objectIdColumn}] = @id;
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
            [${config.objectIdColumn}] AS RowID,
            ${selectCols}
          FROM ${config.tableName}
          WHERE [${config.objectIdColumn}] = @id
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

  app.get("/api/EoiTable", authenticateToken, authorizeRoles("User", "Manager", "Admin"), async (req, res) => {
    try {
      await ensureEoiInfrastructure();
      const p = await getPool();
      const result = await p.request().query(`
        SELECT
          COALESCE(ld.LandID, md.LandID, licd.LandID) AS LandID,
          e.EOIID,
          e.EOIConsumerName,
          e.EOILandType,
          e.EOILandName,
          e.EOIAppliedDate,
          e.EOIStatus
        FROM dbo.EoiRequests e
        LEFT JOIN dbo.LeaseData ld
          ON e.EOILandType = 'lease'
          AND ld.OBJECTID = e.ObjectID
        LEFT JOIN dbo.MarketData md
          ON e.EOILandType = 'market'
          AND md.OBJECTID = e.ObjectID
        LEFT JOIN dbo.LicenseData licd
          ON e.EOILandType = 'license'
          AND licd.OBJECTID = e.ObjectID
        ORDER BY e.EOIID DESC
      `);
      res.json(result.recordset);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "DB query failed" });
    }
  });

  app.post("/api/EoiTable", authenticateToken, authorizeRoles("User", "Admin"), async (req, res) => {
    try {
      await ensureEoiInfrastructure();
      const landTypeRaw = String(req.body?.landType || "").trim().toLowerCase();
      const landType = ["lease", "market", "license"].includes(landTypeRaw) ? landTypeRaw : "";
      const objectId = Number(req.body?.objectId);
      const landNameRaw = req.body?.landName;
      const landName = landNameRaw == null ? null : String(landNameRaw).trim();
      const normalizedLandName = landType === "market" ? null : (landName || null);

      if (!landType) {
        return res.status(400).json({ error: "Invalid land type" });
      }
      if (!Number.isInteger(objectId) || objectId <= 0) {
        return res.status(400).json({ error: "Invalid object id" });
      }

      const p = await getPool();
      let consumerName = String(req.user?.username || "").trim() || "Unknown User";
      let requestedLesseeId = null;

      if (req.user?.role === "User") {
        const lessee = await resolveLesseeByUsername(p, req.user.username);
        if (!lessee?.LesseeID) {
          return res.status(404).json({ error: "Lessee record not found for this user" });
        }
        requestedLesseeId = Number(lessee.LesseeID);
        consumerName = String(lessee.LesseeName || consumerName);
      }

      const duplicateCheck = await p
        .request()
        .input("requestedByUserId", sql.Int, Number(req.user.userId))
        .input("landType", sql.NVarChar(40), landType)
        .input("objectId", sql.Int, objectId)
        .query(`
          SELECT TOP 1 EOIID
          FROM dbo.EoiRequests
          WHERE RequestedByUserID = @requestedByUserId
            AND EOILandType = @landType
            AND ObjectID = @objectId
            AND EOIStatus IN ('Applied', 'Pending')
          ORDER BY EOIID DESC
        `);

      if (duplicateCheck.recordset?.length) {
        return res.status(409).json({ error: "EOI already applied for this land" });
      }

      const insertResult = await p
        .request()
        .input("requestedByUserId", sql.Int, Number(req.user.userId))
        .input("requestedLesseeId", sql.Int, requestedLesseeId)
        .input("consumerName", sql.NVarChar(200), consumerName)
        .input("landType", sql.NVarChar(40), landType)
        .input("landName", sql.NVarChar(200), normalizedLandName)
        .input("objectId", sql.Int, objectId)
        .query(`
          INSERT INTO dbo.EoiRequests
            (RequestedByUserID, RequestedLesseeID, EOIConsumerName, EOILandType, EOILandName, ObjectID)
          OUTPUT
            inserted.EOIID,
            inserted.EOIConsumerName,
            inserted.EOILandType,
            inserted.EOILandName,
            inserted.EOIAppliedDate,
            inserted.EOIStatus
          VALUES
            (@requestedByUserId, @requestedLesseeId, @consumerName, @landType, @landName, @objectId)
        `);

      res.status(201).json(insertResult.recordset?.[0] || null);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "EOI request failed" });
    }
  });

  app.get("/api/EoiApplicants", authenticateToken, authorizeRoles("Admin", "Manager"), async (req, res) => {
    try {
      await ensureEoiInfrastructure();
      const landTypeRaw = String(req.query?.landType || "").trim().toLowerCase();
      const landType = ["lease", "market", "license"].includes(landTypeRaw) ? landTypeRaw : "";
      const objectId = Number(req.query?.objectId);

      if (!landType) {
        return res.status(400).json({ error: "Invalid land type" });
      }
      if (!Number.isInteger(objectId) || objectId <= 0) {
        return res.status(400).json({ error: "Invalid object id" });
      }

      const p = await getPool();
      const result = await p
        .request()
        .input("landType", sql.NVarChar(40), landType)
        .input("objectId", sql.Int, objectId)
        .query(`
          SELECT
            e.EOIID,
            COALESCE(u.Username, e.EOIConsumerName, 'Unknown User') AS Username,
            COALESCE(l.EmailID, CASE WHEN u.Username LIKE '%@%' THEN u.Username ELSE '' END, '') AS Email
          FROM dbo.EoiRequests e
          LEFT JOIN dbo.Users u ON u.UserID = e.RequestedByUserID
          LEFT JOIN dbo.Lessees l ON l.LesseeID = e.RequestedLesseeID
          WHERE e.EOILandType = @landType
            AND e.ObjectID = @objectId
          ORDER BY e.EOIID DESC
        `);

      res.json(result.recordset || []);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to load EOI applicants" });
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

  app.put("/api/UserProfile", authenticateToken, authorizeRoles("User"), async (req, res) => {
    try {
      const p = await getPool();
      const lessee = await resolveLesseeByUsername(p, req.user.username);
      if (!lessee?.LesseeID) {
        return res.status(404).json({ error: "Lessee record not found for this user" });
      }

      const lesseeId = Number(lessee.LesseeID);
      const companyName = String(req.body?.CompanyName ?? "").trim();
      const authorityName = String(req.body?.AuthorityName ?? "").trim();
      const emailId = String(req.body?.EmailId ?? "").trim();
      const phone = String(req.body?.Phone ?? "").trim();
      const address = String(req.body?.Address ?? "").trim();

      const lesseeName = authorityName || companyName;
      if (!lesseeName) {
        return res.status(400).json({ error: "Name is required" });
      }

      await p
        .request()
        .input("lesseeId", sql.Int, lesseeId)
        .input("lesseeName", sql.NVarChar(200), lesseeName)
        .input("emailId", sql.NVarChar(255), emailId || null)
        .input("phone", sql.NVarChar(50), phone || null)
        .input("address", sql.NVarChar(sql.MAX), address || null)
        .query(`
          UPDATE dbo.Lessees
          SET
            LesseeName = @lesseeName,
            EmailID = @emailId,
            ContactNo = @phone,
            Address = @address
          WHERE LesseeID = @lesseeId
        `);

      const result = await p
        .request()
        .input("lesseeId", sql.Int, lesseeId)
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

      res.json(result.recordset?.[0] || null);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Profile update failed" });
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
              COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatus,
              COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatusCode,
              ld.DateFrom,
              ld.DateTo,
              COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
              COALESCE(dn.LandType, CAST('lease' AS VARCHAR(100))) AS LandType,
              COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
              dn.Amount AS OutstandingDue,
              dn.DemandID,
              dn.TransactionID,
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
                d.DemandID,
                d.TransactionID,
                d.DueDate,
                d.Status,
                d.PaymentStatus,
                d.DocumentFileName,
                d.LandType
              FROM dbo.DemandNotes d
              WHERE d.LesseeID = l.LesseeID
                AND d.Status = 'Issued'
                AND (
                  ld.LeaseID IS NULL
                  OR d.LeaseID IS NULL
                  OR CONVERT(VARCHAR(20), d.LeaseID) = CONVERT(VARCHAR(20), ld.LeaseID)
                )
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
            l.LandType,
            ld.LeaseID,
            ld.AreaDivision,
            ld.TotalArea,
            COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatus,
            COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatusCode,
            ld.DateFrom,
            ld.DateTo,
            COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
            COALESCE(dn.LandType, CAST('lease' AS VARCHAR(100))) AS LandType,
            COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
            dn.Amount AS OutstandingDue,
            dn.DemandID,
            dn.TransactionID,
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
              d.DemandID,
              d.TransactionID,
              d.DueDate,
              d.Status,
              d.PaymentStatus,
              d.DocumentFileName,
              d.LandType
            FROM dbo.DemandNotes d
            WHERE d.LesseeID = l.LesseeID
              AND d.Status = 'Issued'
              AND (
                ld.LeaseID IS NULL
                OR d.LeaseID IS NULL
                OR CONVERT(VARCHAR(20), d.LeaseID) = CONVERT(VARCHAR(20), ld.LeaseID)
              )
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
            l.LandType,
            ld.LeaseID,
            ld.AreaDivision,
            ld.TotalArea,
            COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatus,
            COALESCE(dn.PaymentStatus, ld.PaymentStatus) AS PaymentStatusCode,
            ld.DateFrom,
            ld.DateTo,
            COALESCE(dn.DueDate, ld.DateTo) AS LeaseEndDate,
            COALESCE(dn.LandType, CAST('lease' AS VARCHAR(100))) AS LandType,
            COALESCE(CAST(ld.TotalArea AS VARCHAR(200)), CAST('' AS VARCHAR(200))) AS LandName,
            dn.Amount AS OutstandingDue,
            dn.DemandID,
            dn.TransactionID,
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
              d.DemandID,
              d.TransactionID,
              d.DueDate,
              d.Status,
              d.PaymentStatus,
              d.DocumentFileName,
              d.LandType
            FROM dbo.DemandNotes d
            WHERE d.LesseeID = l.LesseeID
              AND d.Status = 'Issued'
              AND (
                ld.LeaseID IS NULL
                OR d.LeaseID IS NULL
                OR CONVERT(VARCHAR(20), d.LeaseID) = CONVERT(VARCHAR(20), ld.LeaseID)
              )
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
