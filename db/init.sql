CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  stock INTEGER NOT NULL
);

INSERT INTO products (id, sku, name, price, stock)
SELECT
  i,
  'SKU-' || lpad(i::text, 7, '0'),
  'Product ' || i,
  round((random() * 500 + 1)::numeric, 2),
  (random() * 1000)::int
FROM generate_series(1, 1000000) AS s(i)
ON CONFLICT (id) DO NOTHING;
