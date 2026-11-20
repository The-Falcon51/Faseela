-- ==========================================================
-- مخطط قاعدة بيانات منصة فسيلة (Faseela Database Schema)
-- النسخة المحدثة 3.0: دعم العملة المزدوجة، التسجيلات الصوتية للمزارعين، والمعاصر
-- ==========================================================

-- 1. جدول المستخدمين وتصاريح الدخول (Users & Auth)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    phone VARCHAR(30) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    country VARCHAR(80) DEFAULT 'Syria',
    wallet_balance NUMERIC(12, 2) DEFAULT 0.00,
    preferred_currency VARCHAR(10) DEFAULT 'USD', -- 'USD' or 'SYP'
    role VARCHAR(30) DEFAULT 'investor', -- 'investor', 'farmer', 'mill_owner', 'admin'
    email_verified_at TIMESTAMP,
    phone_verified_at TIMESTAMP,
    last_login_at TIMESTAMP,
    session_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 1.1 جدول رموز التحقق الأمني المؤقتة (Two-Step Verification Codes - OTP)
CREATE TABLE IF NOT EXISTS auth_verification_codes (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE CASCADE,
    identifier VARCHAR(150) NOT NULL, -- Email or Phone number
    code VARCHAR(10) NOT NULL,
    channel VARCHAR(20) DEFAULT 'SMS_EMAIL', -- 'SMS', 'EMAIL', 'SMS_EMAIL'
    attempts INTEGER DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. جدول المزارع (Farms)
CREATE TABLE IF NOT EXISTS farms (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    owner_name VARCHAR(150) NOT NULL,
    region VARCHAR(100) NOT NULL,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    contact VARCHAR(50),
    certification_status VARCHAR(50) DEFAULT 'organic_verified',
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. جدول معاصر الزيتون (Olive Mills)
CREATE TABLE IF NOT EXISTS mills (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    owner_name VARCHAR(150) NOT NULL,
    region VARCHAR(100) NOT NULL,
    technology_type VARCHAR(100) DEFAULT 'عصر على البارد خطين (Two-Phase Cold Press)',
    capacity_kg_per_hour INTEGER DEFAULT 3500,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    contact VARCHAR(50),
    certification VARCHAR(100) DEFAULT 'معتمدة مخبرياً لإنتاج البكر الممتاز',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. جدول الأشجار (Trees)
CREATE TABLE IF NOT EXISTS trees (
    id VARCHAR(64) PRIMARY KEY,
    farm_id VARCHAR(64) NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    mill_id VARCHAR(64) REFERENCES mills(id) ON DELETE SET NULL,
    tree_name VARCHAR(100) NOT NULL,
    planted_year INTEGER NOT NULL,
    tree_type VARCHAR(80) NOT NULL,
    health_status VARCHAR(50) DEFAULT 'ممتازة',
    total_shares_available INTEGER DEFAULT 100,
    price_per_share_usd NUMERIC(10, 2) NOT NULL,
    price_per_share_syp NUMERIC(14, 2) NOT NULL,
    estimated_annual_yield_kg NUMERIC(8, 2) DEFAULT 45.0,
    carbon_offset_kg_year NUMERIC(6, 2) DEFAULT 22.5,
    gps_lat DOUBLE PRECISION NOT NULL,
    gps_lng DOUBLE PRECISION NOT NULL,
    has_land_option BOOLEAN DEFAULT true,
    land_area_sqm NUMERIC(6, 2) DEFAULT 5.0,
    land_cadastral_zone VARCHAR(150),
    land_parcel_number VARCHAR(80),
    land_soil_type VARCHAR(100),
    land_addon_price_usd NUMERIC(10, 2) DEFAULT 15.00,
    land_polygon_corners JSONB DEFAULT '[]',
    images JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. جدول الحصص الاستثمارية (Shares)
CREATE TABLE IF NOT EXISTS shares (
    id VARCHAR(64) PRIMARY KEY,
    tree_id VARCHAR(64) NOT NULL REFERENCES trees(id) ON DELETE RESTRICT,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    percentage NUMERIC(5, 2) NOT NULL,
    purchase_price NUMERIC(14, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD',
    includes_land BOOLEAN DEFAULT false,
    land_parcel_sqm NUMERIC(6, 2) DEFAULT 0.0,
    land_deed_serial VARCHAR(100),
    certificate_number VARCHAR(100) UNIQUE,
    purchase_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'active'
);

-- 6. جدول المعاملات والمدفوعات (Transactions)
CREATE TABLE IF NOT EXISTS transactions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    amount NUMERIC(14, 2) NOT NULL,
    currency VARCHAR(10) DEFAULT 'USD', -- 'USD', 'SYP'
    type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    payment_method VARCHAR(50), -- 'credit_card', 'syriatel_cash', 'bemo_bank', 'al_haram'
    reference VARCHAR(120),
    proof_image_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. جدول سجلات الصيانة والرعاية والرسائل الصوتية (MaintenanceLogs)
CREATE TABLE IF NOT EXISTS maintenance_logs (
    id VARCHAR(64) PRIMARY KEY,
    tree_id VARCHAR(64) NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    type VARCHAR(80) NOT NULL,
    notes TEXT,
    voice_note_url VARCHAR(500), -- رابط تسجيل صوتي من المزارع
    voice_duration_seconds INTEGER,
    images JSONB DEFAULT '[]',
    performed_by VARCHAR(120),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. جدول دفعات العصر وشهادات الجودة المخبرية (PressingBatches)
CREATE TABLE IF NOT EXISTS pressing_batches (
    id VARCHAR(64) PRIMARY KEY,
    mill_id VARCHAR(64) NOT NULL REFERENCES mills(id) ON DELETE CASCADE,
    farm_id VARCHAR(64) NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
    tree_id VARCHAR(64) REFERENCES trees(id) ON DELETE SET NULL,
    season_year INTEGER NOT NULL,
    pressing_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    olives_weight_kg NUMERIC(8, 2) NOT NULL,
    oil_yield_liters NUMERIC(8, 2) NOT NULL,
    extraction_rate_pct NUMERIC(5, 2) NOT NULL,
    temperature_celsius NUMERIC(4, 1) DEFAULT 24.5,
    acidity_pct NUMERIC(4, 2) NOT NULL,
    peroxide_value NUMERIC(5, 2) DEFAULT 6.2,
    quality_grade VARCHAR(80) DEFAULT 'بكر ممتاز (Extra Virgin)',
    lab_certificate_serial VARCHAR(100) UNIQUE NOT NULL,
    certified_by VARCHAR(150) NOT NULL,
    status VARCHAR(50) DEFAULT 'certified',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. جدول محادثات واستشارات فسيلة (FaseelaConsultations)
CREATE TABLE IF NOT EXISTS faseela_consultations (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    question TEXT NOT NULL,
    response TEXT NOT NULL,
    category VARCHAR(50), -- 'investing', 'olive_care', 'syrian_local_payments', 'milling'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- الفهارس لتحسين الأداء
CREATE INDEX IF NOT EXISTS idx_trees_region ON trees(gps_lat, gps_lng);
CREATE INDEX IF NOT EXISTS idx_transactions_currency ON transactions(currency);
CREATE INDEX IF NOT EXISTS idx_maintenance_tree_date ON maintenance_logs(tree_id, date);

-- 10. جدول سجلات التدقيق والأمان السيبراني (SecurityAuditLogs)
CREATE TABLE IF NOT EXISTS security_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL, -- 'auth_success', 'access_denied', 'rate_limit_exceeded', 'payout_request', 'share_purchase'
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,
    severity VARCHAR(20) DEFAULT 'INFO', -- 'INFO', 'WARN', 'CRITICAL'
    details JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================================
-- سياسات حماية البيانات وأمن الصفوف (PostgreSQL Row Level Security - RLS)
-- لمنع وصول أي مستخدم لبيانات المستخدمين الآخرين وحماية الخصوصية
-- ==========================================================

-- تفعيل أمن الصفوف (RLS) على الجداول الحساسة
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pressing_batches ENABLE ROW LEVEL SECURITY;

-- 1. سياسة جدول المستخدمين: يرى المستخدم بيانات حسابه فقط
CREATE POLICY user_self_access_policy ON users
    FOR ALL
    USING (id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'admin');

-- 2. سياسة جدول الحصص: يرى المستثمر الحصص التي اشتراها فقط
CREATE POLICY investor_shares_isolation_policy ON shares
    FOR ALL
    USING (user_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'admin');

-- 3. سياسة المعاملات المالية: عزل سجلات التحويلات وإيصالات الدفع لكل مستخدم
CREATE POLICY investor_transactions_isolation_policy ON transactions
    FOR ALL
    USING (user_id = current_setting('app.current_user_id', true) OR current_setting('app.current_user_role', true) = 'admin');

-- 4. سياسة سجلات الرعاية الحقلية: المزارع المعتمد يدير أشجار مزرعته فقط
CREATE POLICY farmer_maintenance_policy ON maintenance_logs
    FOR ALL
    USING (
        tree_id IN (
            SELECT t.id FROM trees t
            JOIN farms f ON t.farm_id = f.id
            WHERE f.owner_name = current_setting('app.current_user_name', true)
        )
        OR current_setting('app.current_user_role', true) IN ('admin', 'investor')
    );

-- 5. سياسة معاصر الزيتون: صاحب المعصرة المرخص يسجل ويحرر دفعات معصرته فقط
CREATE POLICY mill_batches_policy ON pressing_batches
    FOR ALL
    USING (
        mill_id IN (
            SELECT m.id FROM mills m
            WHERE m.id = current_setting('app.current_user_mill_id', true)
        )
        OR current_setting('app.current_user_role', true) = 'admin'
    );
