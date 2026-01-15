const jwt = require("jsonwebtoken");
const config = require("../config");

const authMiddleware = {
  // Generate JWT token
  generateToken: (userId) => {
    return jwt.sign({ userId }, config.jwtSecret, {
      expiresIn: config.jwtExpiry,
    });
  },

  // Verify JWT token
  verifyToken: (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Access denied. No token provided.",
      });
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(token, config.jwtSecret);
      req.userId = decoded.userId;
      next();
    } catch (error) {
      return res.status(401).json({
        error: "Invalid or expired token.",
      });
    }
  },

  optionalAuth: (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];

      try {
        const decoded = jwt.verify(token, config.jwtSecret);
        req.userId = decoded.userId;
      } catch (error) {
        req.userId = null;
      }
    }

    next();
  },
};

module.exports = authMiddleware;
