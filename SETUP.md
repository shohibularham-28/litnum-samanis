# LITNUM SMANIS — Panduan Aktivasi Fitur Admin

Semua fitur Admin (Pengguna, Kelas, Kegiatan), fitur Guru (rekap harian/bulanan,
kelola siswa), fitur Siswa (isi ceklis), dan dropdown tanda tangan sekarang
membaca & menulis langsung ke Supabase — tidak ada lagi data "palsu" di JavaScript.

Ikuti 3 langkah ini di project Supabase Anda (`mzmbdqodoycauatcdgre`):

## 1. Jalankan skema database
Buka **Supabase Dashboard → SQL Editor → New query**, salin isi `supabase/schema.sql`,
lalu klik **Run**. Ini membuat tabel `kelas`, `kegiatan`, `ceklis`, menambah kolom
`nip`/`jabatan` ke `profiles`, dan mengatur Row Level Security supaya:
- Admin bisa lihat/ubah semuanya.
- Guru bisa memantau semua kelas, tapi hanya mengelola siswa di kelas walinya.
- Siswa hanya bisa lihat data kelasnya sendiri; hanya "Petugas ceklis" yang bisa mengisi.

Skema ini aman dijalankan berkali-kali.

## 2. Deploy Edge Function `manage-user`
Tombol "Tambah Pengguna" (Admin) dan "Tambah Siswa" (Guru) membuat **akun login
Supabase Auth sungguhan** (email + password), bukan cuma baris tabel. Membuat akun
auth butuh `service_role` key, yang **tidak boleh** ditaruh di app.html karena bisa
dibaca siapa saja lewat "View Source". Karena itu operasi ini dipindah ke Edge
Function yang jalan di server Supabase.

```bash
# Install Supabase CLI kalau belum ada: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref mzmbdqodoycauatcdgre
supabase functions deploy manage-user
```

Tidak perlu set secret manual — `SUPABASE_URL`, `SUPABASE_ANON_KEY`, dan
`SUPABASE_SERVICE_ROLE_KEY` otomatis tersedia untuk semua Edge Function.

## 3. Buat akun Admin pertama
Fungsi `manage-user` hanya bisa dipanggil oleh admin/guru yang sudah punya baris
di `profiles` — jadi admin pertama harus dibuat manual sekali saja:

1. **Authentication → Users → Add user** — masukkan email & password admin.
2. Salin **User UID** yang muncul.
3. Di **SQL Editor**, jalankan:
   ```sql
   insert into public.profiles (id, full_name, role)
   values ('TEMPEL-UID-DI-SINI', 'Nama Admin', 'admin');
   ```
4. Login di `index.html` sebagai Admin dengan email & password tadi.

Setelah ini, semua akun guru & siswa berikutnya bisa dibuat langsung dari menu
Admin/Guru di aplikasi — dropdown tanda tangan, pilihan wali kelas, dan daftar
siswa akan otomatis terisi dari data yang sama.

## Update: kolom Email ditampilkan di daftar Pengguna
- Tabel `profiles` sekarang punya kolom `email` (lihat `supabase/schema.sql`).
  Jalankan ulang skema ini di SQL Editor — perintah di dalamnya otomatis
  mengisi email untuk akun yang **sudah ada** dengan menyalin dari
  `auth.users`, jadi tidak perlu isi manual satu-satu.
- Akun **baru** yang dibuat lewat "Tambah Pengguna" (Admin) atau
  "Tambah Siswa" (Guru) otomatis tersimpan emailnya ke `profiles` — perlu
  **deploy ulang Edge Function `manage-user`** (`supabase functions deploy
  manage-user`) agar perubahan ini aktif.
- Kolom Email sekarang muncul di tabel **Admin → Pengguna** dan
  **Guru → Kelola Siswa**. Kolom ini hanya untuk dilihat (belum bisa diedit
  dari UI, karena mengubah email butuh penanganan khusus lewat
  `supabase.auth.admin.updateUserById`) — kalau perlu ganti email pengguna,
  untuk sementara masih lewat Supabase Dashboard → Authentication → Users.

## Yang berubah di app.html
- **Kegiatan sekarang punya Deskripsi (opsional)**: admin bisa mengisi deskripsi
  kegiatan lewat kolom teks di form Tambah Kegiatan (atau lewat "Edit"). Deskripsi
  ini **tidak** tampil di kartu daftar kegiatan halaman pertama siswa — hanya
  muncul di halaman ceklis (setelah petugas membuka salah satu kegiatan), tepat
  di bawah judul & periode. Jika dikosongkan, baris deskripsi tidak ditampilkan
  sama sekali di halaman ceklis.
- **Kegiatan sekarang punya jam buka**: saat menambah/mengubah kegiatan,
  admin mengisi tanggal mulai **dan jam buka** (WIB). Kegiatan otomatis
  tampil "🔒 Terkunci" di dashboard petugas sampai tanggal & jam itu
  tercapai — begitu waktunya tiba, kartu kegiatan otomatis terbuka tanpa
  perlu refresh manual. Aturan ini juga ditegakkan di server lewat RLS
  (`kegiatan_sudah_dibuka`), jadi tidak bisa dilewati dengan mengubah jam
  di perangkat siswa.
- Satu Supabase client untuk seluruh halaman (sebelumnya dua, dan data admin
  tersimpan di array JS lokal yang hilang tiap refresh — itu sebabnya dropdown
  "Guru Literasi" tidak pernah menampilkan guru yang sudah ada).
- **Admin → Pengguna**: baca/tulis ke `profiles`, tambah akun lewat Edge Function.
- **Admin → Kelas**: CRUD ke tabel `kelas`, wali kelas dipilih dari daftar guru asli.
- **Admin → Kegiatan**: CRUD ke tabel `kegiatan` (tanggal asli, bukan teks statis).
- **Guru → Kelola Siswa**: hanya menampilkan & mengelola siswa di kelas walinya
  sendiri (sesuai RLS), tambah siswa juga lewat Edge Function.
- **Guru → Rekap Harian/Bulanan**: membaca tabel `ceklis`, rekap bulanan dihitung
  langsung dari data (bukan angka contoh).
- **Siswa**: daftar kegiatan, roster teman sekelas, dan simpan ceklis semuanya
  nyambung ke `ceklis` (upsert per kegiatan+siswa+tanggal).
- **Dropdown tanda tangan** (`Guru Literasi` di tiap tombol cetak) sekarang diisi
  dari `profiles` yang berperan `guru` — akan langsung muncul begitu ada guru
  di database, tidak perlu ubah kode lagi.

## Catatan keamanan
- `service_role` key **tidak pernah** ada di app.html — hanya di Edge Function.
- Password akun baru dibuat otomatis (acak) dan ditampilkan sekali ke admin/guru
  setelah submit, untuk disampaikan manual ke pengguna. Sarankan pengguna baru
  segera ganti password (fitur ganti password belum ada di UI — bisa ditambah
  lewat `supabase.auth.updateUser({ password })` bila diperlukan).
