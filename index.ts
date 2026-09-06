// Supabase Edge Function: manage-user
// Menangani pembuatan/ubah/hapus akun (auth.users + public.profiles) dengan
// service_role key di sisi server — kunci ini TIDAK PERNAH dikirim ke browser.
//
// Deploy:
//   supabase functions deploy manage-user
//
// Env yang dibutuhkan (otomatis tersedia di semua Edge Function Supabase):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function randomPassword(len = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) return json({ error: "Tidak ada sesi login." }, 401);

  // Client "sebagai pemanggil" — dipakai hanya untuk memverifikasi siapa yang memanggil.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: callerData, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerData?.user) return json({ error: "Sesi tidak valid." }, 401);
  const callerId = callerData.user.id;

  // Client admin (service role) — satu-satunya yang boleh sentuh auth.users.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: callerProfile, error: callerProfileErr } = await admin
    .from("profiles")
    .select("role, kelas")
    .eq("id", callerId)
    .single();
  if (callerProfileErr || !callerProfile) return json({ error: "Profil pemanggil tidak ditemukan." }, 403);

  const isAdmin = callerProfile.role === "admin";
  const isGuru = callerProfile.role === "guru";
  if (!isAdmin && !isGuru) return json({ error: "Tidak punya izin." }, 403);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body tidak valid." }, 400);
  }
  const { action, payload } = body ?? {};
  if (!action || !payload) return json({ error: "Permintaan tidak lengkap." }, 400);

  // Guru hanya boleh mengelola siswa di kelas walinya sendiri.
  function guruBolehKelola(targetRole: string, targetKelas: string | null) {
    if (isAdmin) return true;
    if (!isGuru) return false;
    return targetRole === "siswa" && targetKelas === callerProfile.kelas;
  }

  try {
    if (action === "create") {
      const { email, password, full_name, role, kelas, nip, jabatan } = payload;
      if (!email || !full_name || !role) return json({ error: "Data tidak lengkap." }, 400);
      if (!guruBolehKelola(role, kelas ?? null)) {
        return json({ error: "Anda tidak berwenang membuat akun peran ini." }, 403);
      }

      const finalPassword = password || randomPassword();
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: finalPassword,
        email_confirm: true,
      });
      if (createErr || !created?.user) return json({ error: createErr?.message || "Gagal membuat akun." }, 400);

      const { error: profileErr } = await admin.from("profiles").insert({
        id: created.user.id,
        full_name,
        role,
        kelas: kelas || null,
        nip: nip || null,
        jabatan: role === "siswa" ? (jabatan || "biasa") : null,
      });
      if (profileErr) {
        // rollback akun auth kalau insert profil gagal, biar tidak jadi akun "yatim"
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: profileErr.message }, 400);
      }

      return json({ ok: true, id: created.user.id, generated_password: password ? undefined : finalPassword });
    }

    if (action === "update") {
      const { id, full_name, role, kelas, nip, jabatan, password } = payload;
      if (!id) return json({ error: "id wajib diisi." }, 400);

      const { data: target, error: targetErr } = await admin
        .from("profiles").select("role, kelas").eq("id", id).single();
      if (targetErr || !target) return json({ error: "Pengguna tidak ditemukan." }, 404);
      if (!guruBolehKelola(target.role, target.kelas)) {
        return json({ error: "Anda tidak berwenang mengubah akun ini." }, 403);
      }
      if (isGuru && role && role !== "siswa") {
        return json({ error: "Guru hanya bisa mengelola akun siswa." }, 403);
      }

      const updateFields: Record<string, unknown> = {};
      if (full_name !== undefined) updateFields.full_name = full_name;
      if (role !== undefined) updateFields.role = role;
      if (kelas !== undefined) updateFields.kelas = kelas || null;
      if (nip !== undefined) updateFields.nip = nip || null;
      if (jabatan !== undefined) updateFields.jabatan = jabatan;

      if (Object.keys(updateFields).length) {
        const { error: updErr } = await admin.from("profiles").update(updateFields).eq("id", id);
        if (updErr) return json({ error: updErr.message }, 400);
      }
      if (password) {
        const { error: pwErr } = await admin.auth.admin.updateUserById(id, { password });
        if (pwErr) return json({ error: pwErr.message }, 400);
      }
      return json({ ok: true });
    }

    if (action === "delete") {
      const { id } = payload;
      if (!id) return json({ error: "id wajib diisi." }, 400);

      const { data: target, error: targetErr } = await admin
        .from("profiles").select("role, kelas").eq("id", id).single();
      if (targetErr || !target) return json({ error: "Pengguna tidak ditemukan." }, 404);
      if (!guruBolehKelola(target.role, target.kelas)) {
        return json({ error: "Anda tidak berwenang menghapus akun ini." }, 403);
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(id);
      if (delErr) return json({ error: delErr.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Aksi tidak dikenal." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
