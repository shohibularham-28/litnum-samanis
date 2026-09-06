-- ============================================================
-- LITNUM SMANIS — skema database Supabase
-- Jalankan di: Supabase Dashboard → SQL Editor → New query → Run
-- Aman dijalankan ulang (pakai IF NOT EXISTS / CREATE OR REPLACE).
-- ============================================================

-- ---------- 1. PROFILES ----------
-- Satu baris per pengguna (admin/guru/siswa), id = auth.users.id
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('admin','guru','siswa')),
  kelas text,                 -- nama kelas (untuk siswa) atau null
  created_at timestamptz not null default now()
);

-- Kalau tabel profiles sudah ada dari sebelumnya (tanpa kolom di bawah ini),
-- tambahkan kolom yang belum ada. Aman dijalankan berkali-kali.
alter table public.profiles add column if not exists nip text;
alter table public.profiles add column if not exists jabatan text default 'biasa';
alter table public.profiles drop constraint if exists profiles_jabatan_check;
alter table public.profiles add constraint profiles_jabatan_check check (jabatan in ('biasa','petugas'));
alter table public.profiles add column if not exists created_at timestamptz not null default now();

-- ---------- 2. KELAS ----------
create table if not exists public.kelas (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique,
  wali_guru_id uuid references public.profiles(id) on delete set null,
  tahun_ajaran text,
  created_at timestamptz not null default now()
);

-- ---------- 3. KEGIATAN LITERASI ----------
create table if not exists public.kegiatan (
  id uuid primary key default gen_random_uuid(),
  judul text not null,
  tanggal_mulai date not null,
  tanggal_selesai date not null,
  status text not null default 'aktif' check (status in ('aktif','selesai')),
  created_at timestamptz not null default now()
);

-- Jam buka kegiatan pada tanggal_mulai — sebelum tanggal & jam ini tercapai,
-- petugas ceklis belum bisa membuka kegiatan (lihat RLS "ceklis_write" di
-- bawah, yang juga menolak insert ceklis sebelum jadwal ini tercapai).
alter table public.kegiatan add column if not exists jam_mulai time not null default '00:00:00';

-- Deskripsi kegiatan (opsional) — ditampilkan di halaman ceklis petugas,
-- tidak ditampilkan di daftar/kartu kegiatan halaman pertama siswa.
alter table public.kegiatan add column if not exists deskripsi text;

-- ---------- 4. CEKLIS HARIAN ----------
-- Satu baris per (kegiatan, siswa, tanggal)
create table if not exists public.ceklis (
  id uuid primary key default gen_random_uuid(),
  kegiatan_id uuid not null references public.kegiatan(id) on delete cascade,
  kelas text not null,
  siswa_id uuid not null references public.profiles(id) on delete cascade,
  tanggal date not null,
  status text not null check (status in ('hadir','tidak','sakit','ijin','alpha','dispen')),
  dicatat_oleh uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  unique (kegiatan_id, siswa_id, tanggal)
);

create index if not exists ceklis_kelas_tanggal_idx on public.ceklis (kelas, tanggal);
create index if not exists ceklis_kegiatan_idx on public.ceklis (kegiatan_id);

-- ============================================================
-- Helper: cek peran pengguna yang sedang login (dipakai di RLS)
-- ============================================================
create or replace function public.current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.current_kelas_wali() returns text
language sql stable security definer set search_path = public as $$
  select nama from public.kelas where wali_guru_id = auth.uid() limit 1;
$$;

create or replace function public.jabatan_petugas() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select jabatan = 'petugas' from public.profiles where id = auth.uid()), false);
$$;

-- Kelas milik pengguna yang sedang login sendiri, dipakai supaya policy
-- "profiles_select_own_or_admin" tidak perlu query ke public.profiles
-- dari dalam kondisinya sendiri (itu penyebab error 42P17 "infinite
-- recursion detected in policy for relation profiles").
create or replace function public.current_kelas() returns text
language sql stable security definer set search_path = public as $$
  select kelas from public.profiles where id = auth.uid();
$$;

-- Sudah lewat tanggal & jam buka kegiatan (WIB) atau belum. Dipakai untuk
-- menahan petugas siswa mengisi ceklis sebelum jadwal yang admin tentukan —
-- diterapkan di server (RLS), bukan cuma di tampilan, supaya tidak bisa
-- dilewati dengan mengubah jam di perangkat siswa.
create or replace function public.kegiatan_sudah_dibuka(p_kegiatan_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select (tanggal_mulai + jam_mulai) <= (now() at time zone 'Asia/Jakarta')
     from public.kegiatan where id = p_kegiatan_id),
    false
  );
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles enable row level security;
alter table public.kelas enable row level security;
alter table public.kegiatan enable row level security;
alter table public.ceklis enable row level security;

-- ---- profiles ----
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (
    id = auth.uid()
    or public.current_role() in ('admin','guru')  -- guru memantau semua kelas
    or (public.current_role() = 'siswa' and kelas = public.current_kelas())
  );

drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update using (public.current_role() = 'admin' or id = auth.uid());

-- Insert/delete on profiles is normally done by the manage-user Edge Function
-- (service role), not directly by clients. No client insert/delete policy is
-- added on purpose — this forces user creation/deletion through the function,
-- which is the only place allowed to also touch auth.users.

-- ---- kelas ----
drop policy if exists "kelas_select_all" on public.kelas;
create policy "kelas_select_all" on public.kelas for select using (auth.uid() is not null);

drop policy if exists "kelas_admin_write" on public.kelas;
create policy "kelas_admin_write" on public.kelas
  for all using (public.current_role() = 'admin') with check (public.current_role() = 'admin');

-- ---- kegiatan ----
drop policy if exists "kegiatan_select_all" on public.kegiatan;
create policy "kegiatan_select_all" on public.kegiatan for select using (auth.uid() is not null);

drop policy if exists "kegiatan_admin_write" on public.kegiatan;
create policy "kegiatan_admin_write" on public.kegiatan
  for all using (public.current_role() = 'admin') with check (public.current_role() = 'admin');

-- ---- ceklis ----
drop policy if exists "ceklis_select" on public.ceklis;
create policy "ceklis_select" on public.ceklis
  for select using (
    public.current_role() in ('admin','guru')  -- guru memantau semua kelas
    or (public.current_role() = 'siswa' and kelas = (select kelas from public.profiles where id = auth.uid()))
  );

drop policy if exists "ceklis_write" on public.ceklis;
create policy "ceklis_write" on public.ceklis
  for insert with check (
    public.current_role() = 'admin'
    or (public.current_role() = 'guru' and kelas = public.current_kelas_wali())
    or (
      public.current_role() = 'siswa' and kelas = (select kelas from public.profiles where id = auth.uid())
      and jabatan_petugas() and public.kegiatan_sudah_dibuka(kegiatan_id)
    )
  );

drop policy if exists "ceklis_update" on public.ceklis;
create policy "ceklis_update" on public.ceklis
  for update using (
    public.current_role() in ('admin','guru')
    or (
      public.current_role() = 'siswa' and kelas = (select kelas from public.profiles where id = auth.uid())
      and jabatan_petugas() and public.kegiatan_sudah_dibuka(kegiatan_id)
    )
  );

drop policy if exists "ceklis_delete_admin_guru" on public.ceklis;
create policy "ceklis_delete_admin_guru" on public.ceklis
  for delete using (
    public.current_role() in ('admin','guru')
  );

-- ============================================================
-- Contoh: buat admin pertama secara manual (jalankan setelah Anda
-- membuat user itu lewat Authentication → Users → Add user di dashboard)
-- ============================================================
-- insert into public.profiles (id, full_name, role)
-- values ('UUID-USER-DARI-AUTH', 'Nama Admin', 'admin');
