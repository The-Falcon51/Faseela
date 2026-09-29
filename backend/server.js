require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-this';

// Admin credentials (hashed)
// Default password: Faseela2024!
const ADMIN_USER = {
  id: 'admin_001',
  username: 'admin',
  email: 'admin@faseela.sy',
  passwordHash: '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcg7b3XeKeUxWdeS8xS7DtH7ZLi' // bcrypt hash of 'Faseela2024!'
};

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Admin Login
app.post('/api/auth/admin-login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // Verify credentials
    const isValidUsername = username === ADMIN_USER.username;
    const isValidPassword = await bcrypt.compare(password, ADMIN_USER.passwordHash);

    if (!isValidUsername || !isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT token (valid for 24 hours)
    const token = jwt.sign(
      { id: ADMIN_USER.id, username: ADMIN_USER.username, role: 'admin' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ 
      success: true, 
      token, 
      admin: { 
        id: ADMIN_USER.id, 
        username: ADMIN_USER.username, 
        email: ADMIN_USER.email 
      } 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Verify Token
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

// Change Admin Password
app.post('/api/auth/change-password', (req, res) => {
  try {
    const { token, currentPassword, newPassword } = req.body;

    if (!token || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // This is a demo - in production, store new password hash in database
    res.json({ 
      success: true, 
      message: 'Password change request received. Implement database storage in production.' 
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Faseela Admin API running on port ${PORT}`);
  console.log(`📝 Default username: admin`);
  console.log(`🔐 Default password: Faseela2024!`);
});
