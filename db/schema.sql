CREATE TABLE owners (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  age INT,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  photo_url TEXT
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  due_at TIMESTAMPTZ,
  last_alert_due TIMESTAMPTZ,
  UNIQUE (owner_id, name)
);

CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('utang','payment')),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  tx_date DATE NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  owner_id INT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE customers ADD COLUMN notified_soon_for TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN last_overdue_reminder DATE;