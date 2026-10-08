import { createClient } from "@supabase/supabase-js";

const url = "http://127.0.0.1:54321";
const key = process.env.TEST_SUPABASE_SERVICE_ROLE;

const admin = createClient(url, key, { auth: { persistSession: false } });

// Check RLS status on subscriptions
const { data, error } = await admin.rpc("exec_sql", {
  query: "SELECT tablename, rowsecurity, forcerowsecurity FROM pg_tables WHERE tablename = 'subscriptions'",
});
console.log("RLS status:", JSON.stringify(data), error);

// Check all policies on subscriptions
const { data: policies, error: polError } = await admin.rpc("exec_sql", {
  query: "SELECT policyname, cmd, roles FROM pg_policies WHERE tablename = 'subscriptions'",
});
console.log("Policies:", JSON.stringify(policies), polError);
