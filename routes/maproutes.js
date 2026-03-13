import express from "express";
import sql from "mssql";
import wk from "wellknown";

const router = express.Router();

router.get("/api/map/wkt", async (req, res) => {
  console.log("Received request for WKT data");
  try {
    const result = await sql.query(`
      SELECT 
      [Shape].STAsText() AS Shape
      ,[Area__in_S]
      ,[LandID]
  FROM [LeaseData]
    `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "No WKT data found" });
    }
    return res.json(result.recordset.map(row => ({
      landId: row.LandID,
      area: row.Area__in_S,
      geometry: wk.parse(row.Shape)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch WKT data" });
  }
});

router.get("/api/plots/:type", async (req, res) => {
  try {

    const type = req.params.type;

    const result = await sql.query(`
      SELECT id, plot_name, type, status, geometry_wkt
      FROM LeaseData
      WHERE type = '${type}'
    `);

    const features = result.recordset.map((row) => ({
      type: "Feature",
      geometry: wk.parse(row.geometry_wkt),
      properties: {
        id: row.id,
        plot_name: row.plot_name,
        type: row.type,
        status: row.status,
      },
    }));
    res.json({
      type: "FeatureCollection",
      features
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch plots" });
  }
});

export default router;