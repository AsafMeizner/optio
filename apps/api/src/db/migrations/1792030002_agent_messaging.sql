-- One run inbox for people and agents; existing user messages retain their identity.
ALTER TABLE task_messages
  ADD COLUMN sender_type text NOT NULL DEFAULT 'user',
  ADD COLUMN sender_name text,
  ADD COLUMN sender_address text;
