// Модуль: Supabase — ініціалізація клієнта для запитів до БД
// URL і anon key вашого проєкту Supabase

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = 'https://osbpjonnlakbqnmpwnpv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9zYnBqb25ubGFrYnFubXB3bnB2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTE0MzYsImV4cCI6MjA5NTk4NzQzNn0.whaY6GhEwPY5dHUk1ToCubq8-X4x9wlYUdB4XUZp4l8';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
