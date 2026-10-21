// 房间号 → 人看得懂的名字（群名、好友昵称）。
// 从 OneBot 拉一次，缓存到 data/rooms.json，重启不用重拉。
import fs from 'node:fs';
import path from 'node:path';

export class RoomNames {
  #file;
  #map = {};
  #loadedAt = 0;

  constructor({ file }) {
    this.#file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
      this.#map = raw.names || {};
      this.#loadedAt = raw.loadedAt || 0;
    } catch {
      this.#map = {};
    }
  }

  get loadedAt() { return this.#loadedAt; }

  nameOf(room) {
    return this.#map[room] || null;
  }

  /** 群名优先，其次好友昵称；拉不到就保持旧值 */
  async refresh(client, logger) {
    try {
      const groups = await client.call('get_group_list');
      const friends = await client.call('get_friend_list');
      const next = { ...this.#map };
      for (const g of groups || []) {
        if (g?.group_id) next[`group:${g.group_id}`] = g.group_name || String(g.group_id);
      }
      for (const f of friends || []) {
        if (f?.user_id) next[`private:${f.user_id}`] = f.remark || f.nickname || String(f.user_id);
      }
      this.#map = next;
      this.#loadedAt = Date.now();
      this.#save();
      logger?.info?.('names', `拉到 ${(groups || []).length} 个群、${(friends || []).length} 个好友`);
      return true;
    } catch (err) {
      logger?.warn?.('names', `拉名字失败：${err?.message ?? err}`);
      return false;
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ names: this.#map, loadedAt: this.#loadedAt }, null, 2), 'utf8');
      fs.renameSync(tmp, this.#file);
    } catch { /* 存不下不影响用 */ }
  }
}
