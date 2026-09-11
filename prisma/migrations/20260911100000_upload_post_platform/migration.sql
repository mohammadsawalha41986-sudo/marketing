-- Upload-Post: a publishing route to several networks, connected per client.
--
-- Appended to the end of the enum, never inserted. PostgreSQL orders enum
-- values by definition order and existing rows hold the values before it, so
-- inserting in the middle would rewrite their ordering.
ALTER TYPE "Platform" ADD VALUE IF NOT EXISTS 'UPLOAD_POST';
