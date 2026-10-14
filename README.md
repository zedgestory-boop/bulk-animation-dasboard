# Bulk Roblox Animation Upload Dashboard

Dashboard untuk mengunggah batch animasi ke akun/grup Roblox menggunakan Roblox Open Cloud Assets API. Gunakan hanya file yang Anda buat sendiri atau yang memang Anda punya izin untuk menerbitkan.

## Fitur

- Antrean browser hingga **1.000 file per batch**, maksimal **10 upload simultan**.
- Upload animasi dengan Roblox Open Cloud Assets API.
- Target creator dapat dipilih per batch: akun pribadi (`userId`) atau grup (`groupId`), melalui panel **Ganti Target Upload**.
- Target default di Railway: isi salah satu `ROBLOX_USER_ID` atau `ROBLOX_GROUP_ID`; target panel dapat menimpa default untuk upload saat itu.
- Polling status operasi Roblox, progress, retry manual, CSV hasil.
- Scan referensi `rbxassetid://` dari file RBXM/RBXMX.
- Patcher untuk mengganti referensi ID dalam file `.rbxm`, `.rbxmx`, `.lua`, dan `.txt`, lalu mengunduh salinan yang sudah diperbarui. Untuk file Lua/TXT, ID numerik biasa juga diganti.
- Health endpoint `/health`, diagnosis API, dan proteksi Basic Auth dashboard.

### Format animasi

Roblox Open Cloud Assets API menerima animasi dalam format **.rbxm** dan **.rbxmx**, dengan MIME type `model/x-rbxm`; batas unggah dokumentasi Roblox adalah **20 MB per file**. File yang diedit di luar Roblox Studio bisa saja tidak dapat diunggah atau berfungsi. File `.fbx` bukan format Animation untuk endpoint ini. Referensi ID hanya disimpan sebagai catatan dan tidak diunduh/diunggah ulang.

## Variabel Railway

Tambahkan melalui **Railway → service → Variables**. Dashboard menolak akses jika password ini belum disetel:

| Variable | Nilai |
|---|---|
| `ROBLOX_API_KEY` | API key Open Cloud, simpan sebagai secret |
| `ROBLOX_USER_ID` | ID akun pribadi default (opsional; gunakan jika target default adalah akun pribadi) |
| `ROBLOX_GROUP_ID` | ID grup default (opsional; gunakan jika target default adalah grup) |
| `DASHBOARD_PASSWORD` | Password dashboard yang kuat; username Basic Auth adalah `admin` |
| `PORT` | Biasanya disediakan otomatis oleh Railway; jangan set manual kecuali diperlukan |

Untuk upload aset grup, API key harus memiliki izin Assets yang diperlukan dan pembuat key harus punya izin membuat aset di grup. Untuk upload akun pribadi, pastikan API key dan izin aset cocok dengan akun target. Jangan memasukkan API key ke HTML, GitHub, atau kode browser. Jangan memasukkan API key ke HTML, GitHub, atau kode browser.

## Deploy di Railway

1. Buka Railway dan pilih project/service yang terhubung ke repository ini.
2. Pastikan Source mengarah ke branch `main` dan root directory kosong (root repository).
3. Buka **Variables**, tambahkan `ROBLOX_API_KEY`, salah satu dari `ROBLOX_USER_ID` atau `ROBLOX_GROUP_ID` (untuk default), dan `DASHBOARD_PASSWORD`. Jika memilih target creator di panel, isi ID numerik akun/grup yang benar.
4. Buka **Settings → Networking** dan buat/gunakan public domain.
5. Dari **Deployments**, pilih **Deploy latest commit** atau lakukan redeploy setelah commit terbaru.
6. Tunggu deployment berhasil. Buka `https://DOMAIN-RAILWAY/health`; respons yang diharapkan adalah JSON dengan `"status":"ok"`.
7. Buka domain dashboard. Saat diminta login Basic Auth, masukkan username `admin` dan password dari `DASHBOARD_PASSWORD`.
8. Klik **Test Koneksi Roblox API**. Tes ini hanya diagnosis awal; upload satu file kecil yang Anda miliki untuk memverifikasi izin dan konfigurasi grup secara nyata.
9. Pilih beberapa file `.rbxm`/`.rbxmx` dulu sebagai uji coba. Pastikan aset muncul di Creator Dashboard grup sebelum menjalankan batch besar.

## Lokal

Node.js 20 atau lebih baru:

```bash
npm install
npm start
```

Lalu buka `http://localhost:8080` (atau port yang ditentukan oleh `PORT`).

## Catatan

- Batch 1.000 adalah antrean pada browser; Roblox tetap memproses tiap file sebagai request terpisah dan menerapkan batas/rate limit platform.
- Jangan otomatis mengulang item berstatus `uncertain` sebelum memeriksa Creator Dashboard, karena permintaan mungkin sudah diterima Roblox.
- Endpoint `/api/spoof-by-id` dinonaktifkan. Asset ID referensi tidak dipakai untuk mengunduh atau memindahkan aset antar-creator.
- Assets API Roblox masih memiliki endpoint beta dan perilakunya dapat berubah. Dokumentasi: https://create.roblox.com/docs/cloud/guides/usage-assets
