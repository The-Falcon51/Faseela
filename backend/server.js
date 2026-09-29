require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'faseela-secret-key-change-in-production';

// Middleware
app.use(cors());
app.use(express.json());

// SQLite Database Setup
const dbPath = path.join(__dirname, 'faseela.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database error:', err);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    // Admin Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
      )
    `);

    // Regular Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        phone TEXT,
        role TEXT DEFAULT 'investor',
        region TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Admin Activity Log
    db.run(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (admin_id) REFERENCES admin_users(id)
      )
    `);

    // Create default admin if not exists
    createDefaultAdmin();
  });
}

function createDefaultAdmin() {
  const hashedPassword = bcrypt.hashSync('Faseela2024!', 10);
  
  db.get(
    'SELECT * FROM admin_users WHERE email = ?',
    ['admin@faseela.sy'],
    (err, row) => {
      if (!row) {
        db.run(
          `INSERT INTO admin_users (email, username, password_hash, role) 
           VALUES (?, ?, ?, ?)`,
          ['admin@faseela.sy', 'admin', hashedPassword, 'admin'],
          (err) => {
            if (!err) {
              console.log('✅ Default admin created: admin@faseela.sy / Faseela2024!');
            }
          }
        );
      }
    }
  );
}

// ================= HEALTH CHECK =================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ================= ADMIN LOGIN =================
app.post('/api/auth/admin-login', (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    db.get(
      'SELECT * FROM admin_users WHERE email = ?',
      [email],
      (err, admin) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }

        if (!admin) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        const isValidPassword = bcrypt.compareSync(password, admin.password_hash);

        if (!isValidPassword) {
          return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Update last login
        db.run(
          'UPDATE admin_users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
          [admin.id]
        );

        // Generate JWT token
        const token = jwt.sign(
          { id: admin.id, email: admin.email, role: admin.role },
          JWT_SECRET,
          { expiresIn: '24h' }
        );

        res.json({
          success: true,
          token,
          admin: {
            id: admin.id,
            email: admin.email,
            username: admin.username,
            role: admin.role
          }
        });
      }
    );
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================= VERIFY TOKEN =================
app.post('/api/auth/verify-token', (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, admin: decoded });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid or expired token' });
  }
});

// ================= MIDDLEWARE: VERIFY ADMIN TOKEN =================
function verifyAdminToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ================= ADMIN ENDPOINTS =================

// Get all users (admin only)
app.get('/api/admin/users', verifyAdminToken, (req, res) => {
  db.all('SELECT * FROM users ORDER BY created_at DESC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ users: rows || [] });
  });
});

// Get admin activity log (admin only)
app.get('/api/admin/logs', verifyAdminToken, (req, res) => {
  db.all(
    `SELECT al.*, au.email as admin_email 
     FROM admin_logs al 
     JOIN admin_users au ON al.admin_id = au.id 
     ORDER BY al.created_at DESC LIMIT 100`,
    [],
    (err, rows) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ logs: rows || [] });
    }
  );
});

// Log admin action
app.post('/api/admin/logs', verifyAdminToken, (req, res) => {
  const { action, details } = req.body;

  if (!action) {
    return res.status(400).json({ error: 'Action required' });
  }

  db.run(
    'INSERT INTO admin_logs (admin_id, action, details) VALUES (?, ?, ?)',
    [req.admin.id, action, details || null],
    (err) => {
      if (err) {
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ success: true });
    }
  );
});

// Change admin password (admin only)
app.post('/api/admin/change-password', verifyAdminToken, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    db.get(
      'SELECT * FROM admin_users WHERE id = ?',
      [req.admin.id],
      (err, admin) => {
        if (err) {
          return res.status(500).json({ error: 'Database error' });
        }

        if (!admin) {
          return res.status(404).json({ error: 'Admin not found' });
        }

        const isValidPassword = bcrypt.compareSync(currentPassword, admin.password_hash);

        if (!isValidPassword) {
          return res.status(401).json({ error: 'Current password is incorrect' });
        }

        const newHash = bcrypt.hashSync(newPassword, 10);

        db.run(
          'UPDATE admin_users SET password_hash = ? WHERE id = ?',
          [newHash, req.admin.id],
          (err) => {
            if (err) {
              return res.status(500).json({ error: 'Database error' });
            }

            res.json({ success: true, message: 'Password changed successfully' });
          }
        );
      }
    );
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
🚀 Faseela Admin API v2 running on port ${PORT}
📝 Default admin email: admin@faseela.sy
🔐 Default password: Faseela2024!
💾 Database: ${dbPath}
  `);
});
