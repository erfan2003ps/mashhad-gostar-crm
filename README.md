# سامانه CRM مشهد گستر

نسخه وب فروش، باشگاه مشتریان، میز کار، گپ و آلارم سرویس.

```bash
npm start
```

پیش‌فرض روی پورت `3000` است و فایل `index.html` را سرو می‌کند.

## قابلیت‌های سرور
- همگام‌سازی چندکاربره با merge-by-id و soft-delete
- جریان آنی SSE روی `/api/chat/stream`
- دلتای سبک `/api/ws?since=` و `/api/state?since=`
- بکاپ روزانه در پوشه `backups/`
- داده در `data/crm_state_v8.json` (بدون لایه رمزنگاری اجباری)

متغیرهای محیط: `PORT`، `MG_DATA_DIR`.

```bash
npm run check
```
