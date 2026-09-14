# scripts/enable-dm.py —— 把实例从「小说式」切换为「DM 式」（跑团 / 语C / 聊天式）
#
# 标准流程，幂等，可重复运行：
#   1. runtime/sandbox/{novel-main.js, page-bar.js} → runtime/sandbox/disabled/
#   2. runtime/sandbox/disabled/dm-main.js         → runtime/sandbox/
#   3. 清空 runtime/floors/ 下的正文楼层（DM 式不走小说楼层历史）
#   4. dm.yaml.example                            → dm.yaml
#   5. 更新 teahouse.md 中「如何启用 DM」章节为「DM 模式（当前已启用）」
#
# 调用：RunScript(path="scripts/enable-dm.py")

async def run(t, args):
    SB = "runtime/sandbox"
    DIS = SB + "/disabled"
    notes = []

    # 1) 小说式主循环与翻页器 → disabled/
    for name in ("novel-main.js", "page-bar.js"):
        src = SB + "/" + name
        dst = DIS + "/" + name
        if t.file_exists(src):
            r = await t.run_tool("FileOps", {"action": "move", "path": src, "destination": dst})
            if isinstance(r, str) and r.startswith("Error"):
                notes.append("  [错误] 移入失败 %s : %s" % (src, r))
            else:
                notes.append("  [OK] %s → %s" % (src, dst))
        else:
            notes.append("  [跳过] 源不存在（可能已禁用）：%s" % src)

    # 2) dm-main.js 从 disabled/ 移出
    src = DIS + "/dm-main.js"
    dst = SB + "/dm-main.js"
    if t.file_exists(src):
        r = await t.run_tool("FileOps", {"action": "move", "path": src, "destination": dst})
        if isinstance(r, str) and r.startswith("Error"):
            notes.append("  [错误] 移出失败：%s" % r)
        else:
            notes.append("  [OK] %s → %s" % (src, dst))
    else:
        notes.append("  [跳过] 源不存在（可能已移出）：%s" % src)

    # 3) 清空 floors/ 下的正文楼层
    floors_dir = "runtime/floors"
    cnt = 0
    for f in t.list_files(floors_dir):
        p = f if f.startswith("runtime/") else floors_dir + "/" + f
        if p.endswith(".md"):
            r = await t.run_tool("FileOps", {"action": "delete", "path": p})
            if isinstance(r, str) and r.startswith("Error"):
                notes.append("  [错误] 删除失败 %s : %s" % (p, r))
            else:
                notes.append("  [OK] 删除 %s" % p)
                cnt += 1
    if cnt == 0:
        notes.append("  [跳过] floors/ 下无 .md 楼层")

    # 4) dm.yaml.example → dm.yaml
    ex = "dm.yaml.example"
    dy = "dm.yaml"
    if t.file_exists(ex):
        r = await t.run_tool("FileOps", {"action": "move", "path": ex, "destination": dy})
        if isinstance(r, str) and r.startswith("Error"):
            notes.append("  [错误] 改名失败：%s" % r)
        else:
            notes.append("  [OK] %s → %s" % (ex, dy))
    elif t.file_exists(dy):
        notes.append("  [跳过] dm.yaml 已存在")
    else:
        notes.append("  [警告] 未找到 %s" % ex)

    # 5) 更新 teahouse.md 的 DM 说明章节
    NEW_SECTION = (
        "## DM 模式（当前已启用）\n"
        "\n"
        "本实例运行在 **DM 式**（跑团 / 语C / 聊天式）：玩家在游玩视图与 DM 对话，DM 用 `Output` 把发言呈现为气泡（记录落在 `runtime/dm-output.jsonl`）。\n"
        "\n"
        "- 提示词：`dm.yaml`（已启用）；渲染器：`runtime/sandbox/dm-main.js`。\n"
        "- 小说式主循环与翻页器（`novel-main.js`、`page-bar.js`）已禁用，存于 `runtime/sandbox/disabled/`。\n"
        "- 请按设定补全 `dm.yaml`：指出设定都位于哪里、应该阅读哪些内容。\n"
        "- 一键切换脚本：`scripts/enable-dm.py`。\n"
    )
    th_path = "teahouse.md"
    if t.file_exists(th_path):
        th = t.read_file(th_path)
        keys = ("## DM 模式", "## 如何启用 DM")
        idx, key = -1, ""
        for k in keys:
            i = th.find(k)
            if i != -1:
                idx, key = i, k
                break
        if idx == -1:
            notes.append("  [跳过] teahouse.md 未找到「## DM 模式」/「## 如何启用 DM」章节，说明未改")
        else:
            nxt = th.find("\n## ", idx + len(key))
            if nxt == -1:
                nxt = len(th)
            t.write_file(th_path, th[:idx] + NEW_SECTION + th[nxt:])
            notes.append("  [OK] 已更新 teahouse.md 的 DM 说明")
    else:
        notes.append("  [警告] 未找到 teahouse.md")

    print("enable-dm 转换结果：\n" + "\n".join(notes))
    return "enable-dm 完成"
