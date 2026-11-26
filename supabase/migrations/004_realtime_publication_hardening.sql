-- Non-destructive Supabase Realtime Publication Hardening
-- Idempotent: safely enables Postgres Realtime replication for chat & call signaling tables
-- while preserving all existing Row-Level Security (RLS) policies.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rc_messages'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rc_messages;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rc_message_reactions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rc_message_reactions;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rc_conversation_settings'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rc_conversation_settings;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rc_call_signals'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.rc_call_signals;
    END IF;
  END IF;
END $$;

ALTER TABLE IF EXISTS public.rc_messages REPLICA IDENTITY FULL;
ALTER TABLE IF EXISTS public.rc_call_signals REPLICA IDENTITY FULL;
