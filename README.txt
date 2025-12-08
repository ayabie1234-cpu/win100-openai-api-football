
# Win 100% – Live Scanner (API-Football + OpenAI)

โปรเจคนี้คือระบบตัวอย่างสำหรับ:
- ดึงข้อมูลบอลสดจริงจาก **API-Football (v3)**  
- ใช้สูตร rule-based 3 แบบ:
  1. สูตรบุกข้างเดียว
  2. สูตรราคาบอล
  3. สูตรสูง/ต่ำ
- ให้ **OpenAI (เช่น gpt-4.1-mini)** ช่วยอธิบายเหตุผลเพิ่มสำหรับคู่ที่เข้าเงื่อนไข
- แสดงผลบนหน้าเว็บ + เล่นเสียงเตือนเมื่อมีคู่ใหม่เข้าเงื่อนไข Win 100%

## การติดตั้ง

```bash
npm install
```

คัดลอกไฟล์ `.env.example` เป็น `.env` แล้วใส่ค่า:

```ini
API_FOOTBALL_KEY=YOUR_API_FOOTBALL_KEY_HERE
OPENAI_API_KEY=YOUR_OPENAI_KEY_HERE
PORT=3000
```

จากนั้นรัน:

```bash
npm start
```

แล้วเปิดเว็บที่ `http://localhost:3000`
