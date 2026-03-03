export function registerAuthRoutes(app, deps) {
  const {
    sql,
    getPool,
    normalizeUsername,
    verifyPassword,
    hashPassword,
    issueAccessToken,
    getAttemptKey,
    isBlockedAttempt,
    registerFailedAttempt,
    clearFailedAttempts,
    recordAuthEvent,
    resolveLesseeByUsername,
    authenticateToken,
    JWT_SECRET,
  } = deps;

  app.post("/api/auth/login", async (req, res) => {
    const username = String(req.body?.username || "").trim();
    const usernameNormalized = normalizeUsername(username);
    const password = String(req.body?.password || "");
    const ipAddress = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;
    const userAgent = req.headers["user-agent"] || null;

    if (!JWT_SECRET) {
      return res.status(500).json({ error: "Server auth configuration is incomplete" });
    }

    if (!usernameNormalized || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const attemptKey = getAttemptKey(req, usernameNormalized);
    const attempt = deps.loginAttemptState.get(attemptKey);
    if (isBlockedAttempt(attempt)) {
      return res.status(429).json({ error: "Too many failed attempts. Try again later." });
    }

    try {
      const p = await getPool();
      const result = await p
        .request()
        .input("usernameNormalized", sql.NVarChar(120), usernameNormalized)
        .query(`
          SELECT
            u.UserID,
            u.Username,
            u.DisplayName,
            u.PasswordHash,
            u.IsActive,
            r.RoleName
          FROM dbo.Users u
          INNER JOIN dbo.Roles r ON r.RoleID = u.RoleID
          WHERE u.UsernameNormalized = @usernameNormalized
        `);

      const row = result.recordset[0];
      const badCredResponse = { error: "Invalid username or password" };
      if (!row || !row.IsActive || !verifyPassword(password, row.PasswordHash)) {
        registerFailedAttempt(attemptKey);
        await recordAuthEvent({
          usernameAttempt: usernameNormalized,
          actionType: "LOGIN",
          status: "FAIL",
          reason: "Invalid credentials",
          ipAddress,
          userAgent,
        });
        return res.status(401).json(badCredResponse);
      }

      if (row.RoleName === "User") {
        const lesseeMatch = await resolveLesseeByUsername(p, row.Username);
        if (!lesseeMatch) {
          registerFailedAttempt(attemptKey);
          await recordAuthEvent({
            userId: row.UserID,
            usernameAttempt: usernameNormalized,
            actionType: "LOGIN",
            status: "FAIL",
            reason: "No matching lessee record",
            ipAddress,
            userAgent,
          });
          return res.status(403).json({ error: "No matching lessee record for this user account" });
        }
      }

      clearFailedAttempts(attemptKey);
      const user = {
        userId: Number(row.UserID),
        username: row.Username,
        displayName: row.DisplayName || row.Username,
        role: row.RoleName,
      };
      await p
        .request()
        .input("userId", sql.Int, user.userId)
        .query("UPDATE dbo.Users SET LastLoginAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME() WHERE UserID = @userId");
      const accessToken = issueAccessToken(user);

      await recordAuthEvent({
        userId: row.UserID,
        usernameAttempt: usernameNormalized,
        actionType: "LOGIN",
        status: "SUCCESS",
        reason: null,
        ipAddress,
        userAgent,
      });

      return res.json({
        token: accessToken,
        user: {
          id: user.userId,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Authentication failed" });
    }
  });

  app.get("/api/auth/me", authenticateToken, async (req, res) => {
    try {
      const p = await getPool();
      const result = await p
        .request()
        .input("userId", sql.Int, req.user.userId)
        .query(`
          SELECT
            u.UserID,
            u.Username,
            u.DisplayName,
            u.IsActive,
            r.RoleName
          FROM dbo.Users u
          INNER JOIN dbo.Roles r ON r.RoleID = u.RoleID
          WHERE u.UserID = @userId
        `);

      const row = result.recordset[0];
      if (!row || !row.IsActive) {
        return res.status(401).json({ error: "User session is no longer valid" });
      }

      return res.json({
        user: {
          id: Number(row.UserID),
          username: row.Username,
          displayName: row.DisplayName || row.Username,
          role: row.RoleName,
        },
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Session check failed" });
    }
  });

  app.post("/api/auth/change-password", authenticateToken, async (req, res) => {
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new passwords are required" });
    }
    if (newPassword.length < 12) {
      return res.status(400).json({ error: "New password must be at least 12 characters" });
    }

    try {
      const p = await getPool();
      const userResult = await p
        .request()
        .input("userId", sql.Int, req.user.userId)
        .query("SELECT UserID, PasswordHash, IsActive FROM dbo.Users WHERE UserID = @userId");

      const row = userResult.recordset[0];
      if (!row || !row.IsActive || !verifyPassword(currentPassword, row.PasswordHash)) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }

      const nextHash = hashPassword(newPassword);
      await p
        .request()
        .input("userId", sql.Int, req.user.userId)
        .input("passwordHash", sql.NVarChar(sql.MAX), nextHash)
        .query(`
          UPDATE dbo.Users
          SET PasswordHash = @passwordHash, UpdatedAt = SYSUTCDATETIME()
          WHERE UserID = @userId
        `);

      return res.json({ success: true });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Password update failed" });
    }
  });
}
