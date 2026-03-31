-- EPAM CLI Development Database Schema

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    kratos_id VARCHAR(255) UNIQUE,
    tier VARCHAR(50) DEFAULT 'free' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    tier VARCHAR(50) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    label VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL,
    model VARCHAR(255) NOT NULL,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Seed dev users
INSERT INTO users (id, email, name, tier) VALUES
    ('00000000-0000-0000-0000-000000000001', 'dev@example.com', 'Dev User', 'pro'),
    ('00000000-0000-0000-0000-000000000002', 'free@example.com', 'Free User', 'free'),
    ('00000000-0000-0000-0000-000000000003', 'enterprise@example.com', 'Enterprise User', 'enterprise')
ON CONFLICT (email) DO NOTHING;

INSERT INTO subscriptions (user_id, tier, starts_at, expires_at) VALUES
    ('00000000-0000-0000-0000-000000000001', 'pro', NOW(), NOW() + INTERVAL '1 year'),
    ('00000000-0000-0000-0000-000000000003', 'enterprise', NOW(), NOW() + INTERVAL '1 year')
ON CONFLICT DO NOTHING;
