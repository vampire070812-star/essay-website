# -*- coding: utf-8 -*-
"""
试运行账号批量生成脚本
======================
试运行期间不开放注册，仅发放固定账号密码登录。

用法（在项目根目录）：
    python create_accounts.py            # 生成 100 个账号（user001 ~ user100）
    python create_accounts.py --count 50 # 生成 50 个

行为说明：
- 账号名：user001 ~ user100
- 密码：8 位随机（不含易混淆字符 0/O/1/l/I），每个账号独立
- 账号已存在时：重置为本次生成的新密码（保证清单与数据库始终一致）
- 清单写入 data/账号清单-试运行.txt（data/ 已被 .gitignore 忽略，不会外泄）
- 密码使用与服务端一致的 PBKDF2-SHA256 加盐哈希存储，清单是唯一明文出处
"""

import argparse
import os
import secrets
import sys
import time

# 保证以脚本所在目录为根（data/ 目录位置正确、server 可导入）
ROOT = os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)
sys.path.insert(0, ROOT)

import server as sg  # 复用服务端同一套 PBKDF2 哈希与数据库

# 不含易混淆字符（0/O、1/l/I）的密码字母表
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789"
PASSWORD_LEN = 8


def gen_password():
    """生成 8 位随机密码，确保同时包含大写、小写、数字。"""
    for _ in range(20):
        pw = "".join(secrets.choice(ALPHABET) for _ in range(PASSWORD_LEN))
        if (any(c.isupper() for c in pw)
                and any(c.islower() for c in pw)
                and any(c.isdigit() for c in pw)):
            return pw
    return pw  # 极小概率 20 次都不满足，直接用最后一次


def main():
    parser = argparse.ArgumentParser(description="批量生成试运行账号")
    parser.add_argument("--count", type=int, default=100, help="生成数量，默认 100")
    parser.add_argument("--prefix", type=str, default="user", help="账号名前缀，默认 user")
    args = parser.parse_args()

    count = max(1, min(args.count, 1000))
    sg.init_db()
    db = sg.db

    rows = []          # (login, password)
    created, updated = 0, 0

    for i in range(1, count + 1):
        login = "%s%03d" % (args.prefix, i)
        pw = gen_password()
        pw_hash = sg.hash_password(pw)
        with sg.db_lock:
            cur = db.execute("SELECT id FROM users WHERE login=?", (login,))
            if cur.fetchone():
                db.execute("UPDATE users SET pw_hash=? WHERE login=?", (pw_hash, login))
                updated += 1
            else:
                db.execute(
                    "INSERT INTO users(login, display_name, pw_hash, created_at) VALUES(?,?,?,?)",
                    (login, login, pw_hash, int(time.time())))
                created += 1
        rows.append((login, pw))
    db.commit()

    # 写清单文件（data/ 已被 .gitignore 忽略）
    os.makedirs("data", exist_ok=True)
    out_path = os.path.join("data", "账号清单-试运行.txt")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("作文批改网站 · 试运行账号清单\n")
        f.write("共 %d 个账号（%s001 ~ %s%03d）· 生成时间 %s\n" % (
            count, args.prefix, args.prefix, count,
            time.strftime("%Y-%m-%d %H:%M")))
        f.write("格式：账号  密码（区分大小写，登录地址见网站首页右上角“登录”）\n")
        f.write("-" * 44 + "\n")
        for login, pw in rows:
            f.write("%s  %s\n" % (login, pw))

    print("完成：新建 %d 个，重置已存在 %d 个" % (created, updated))
    print("清单已写入：%s" % os.path.abspath(out_path))
    print("预览前 5 个：")
    for login, pw in rows[:5]:
        print("  %s  %s" % (login, pw))


if __name__ == "__main__":
    main()
