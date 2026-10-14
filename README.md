# Bulk Roblox Animation Spoofer & Dashboard

Aplikasi web untuk mengunggah dan melakukan spoofing animasi Roblox secara massal (bulk) hingga 1.000 file (.rbxm, .rbxmx, .fbx) dengan antrean 10 pekerja (concurrency workers) simultan serta integrasi penuh ke Railway dan Roblox Open Cloud Assets API.

## Fitur Utama

- **10 Worker Concurrent Queue**: Memproses hingga 1.000 file sekaligus dengan 10 slot upload aktif secara paralel untuk kecepatan maksimal.
- **Bulk Animation Spoofing**: Unggah animasi ke akun atau grup pribadi Anda untuk mendapatkan Asset ID baru yang valid dan dimiliki oleh creator Anda.
- **RBXM / RBXMX Patcher**: Ganti ID animasi lama di dalam file model / rig RBXM dengan ID baru yang telah dispoof, lalu unduh file `.rbxm` hasil siap pakai secara instan.
- **Pemindai RBXM / RBXMX**: Ekstrak semua referensi `rbxassetid://` dari file biner model atau rig tanpa perlu membuka Roblox Studio.
- **Export Hasil**: Unduh CSV hasil upload atau ekspor tabel kamus Lua (`SpoofedAnimations.lua`) untuk disalin langsung ke skrip Roblox Studio.
- **Integrasi Railway**: Dilengkapi status koneksi Railway otomatis, health check, pengujian koneksi ke Roblox API, dan override target creator.

## Variabel Lingkungan (Railway / .env)

Tambahkan variabel berikut pada tab **Variables** di Railway Dashboard Anda:

| Variabel | Keterangan | Wajib? |
|---|---|---|
| `PORT` | Port server (default: `3000`) | Otomatis |
| `ROBLOX_API_KEY` | Roblox Open Cloud API Key dengan izin `Assets:write` dan `Assets:read` | **Wajib** untuk upload |
| `ROBLOX_USER_ID` | ID akun Roblox pribadi tempat animasi diunggah | Salah satu |
| `ROBLOX_GROUP_ID` | ID grup Roblox tempat animasi diunggah | Salah satu |
| `DASHBOARD_PASSWORD` | Password untuk mengunci dashboard (username: `admin`) | Opsional |

## Menjalankan Secara Lokal

```bash
npm install
npm run dev
```

Buka browser di `http://localhost:3000`.