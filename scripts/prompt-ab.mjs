// 承重词实验：同一张工作流、同一个种子，只改正提示词里的某几个词，看耳朵长成什么。
// 用法：node tmp/prompt-ab/ab.mjs --fast --size 576x768 --steps 12 --seed 1234 [--only=base]
//   --fast  砍掉放大 + FaceDetailer，只出底图（快，够看耳朵）
//   不加 --fast 就整条链路跑满（慢，但在白天跑）
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { readWorkflowFile, uiToApi } from 'file:///E:/DSHwork/Code/dsh-qwen-paint/lib/workflow-file.js'

const HOST = 'http://127.0.0.1:8188'
const WF = 'E:/ComfyUI/ComfyUI/user/default/workflows/小鲸鱼专用.json'
const HERE = 'tmp/prompt-ab'

const BASE = 'blue eyes, animal ears, blue hair, ahoge, maid headdress, fins, fish tail, cetacean tail'
const TAIL = '\n\n(@ask \\(askzy\\):0.8),(@tianliang duohe fangdongye:1.2)\n'

// 正提示词里的关键词，只动这一串；后面的 LoRA 尾巴原样保留
const VARIANTS = {
  base: BASE,
  'no-fins': BASE.replace('fins, ', ''),
  webbed: BASE.replace('fins', 'webbed fin ears'),
  smooth: BASE.replace('fins', 'smooth cetacean fins'),
  'no-tail': BASE.replace(', cetacean tail', ''), // 对照：动一个不该影响耳朵的词
  // 正对照：换一个明确不同类的耳朵。要是这个也不改耳朵，那就不是「fins 这个词不承重」，
  // 是这一整套词都不承重——耳朵另有来处（角色 LoRA）。
  'cat-ears': BASE.replace('fins', 'cat ears'),
  'no-lora': BASE, // 配合 --nolora 用：把尾巴里那句 @askzy 拿掉
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v ?? true]
  }),
)
const FAST = args.fast === true
const [W, H] = String(args.size ?? '576x768').split('x').map(Number)
const STEPS = Number(args.steps ?? 12)
const SEED = Number(args.seed ?? 1234)
const only = args.only ? String(args.only).split(',') : null
const names = Object.keys(VARIANTS).filter((n) => !only || only.includes(n))

const ui = await readWorkflowFile(WF)
const objectInfo = JSON.parse(await fsp.readFile(`${HERE}/object_info.json`, 'utf8'))
await fsp.mkdir(`${HERE}/out`, { recursive: true })

function strip(p, ids) {
  for (const id of ids) delete p[id]
}

async function submit(prompt) {
  const res = await fetch(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: crypto.randomUUID() }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.prompt_id) throw new Error(`提交失败 ${res.status}: ${JSON.stringify(body).slice(0, 600)}`)
  return body.prompt_id
}

async function waitFor(id, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const hist = await fetch(`${HOST}/history/${id}`).then((r) => r.json()).catch(() => ({}))
    const entry = hist[id]
    if (entry?.status?.status_str === 'error') throw new Error(`执行出错: ${JSON.stringify(entry.status).slice(0, 800)}`)
    if (entry?.outputs && Object.keys(entry.outputs).length) return entry
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('等超时')
}

for (const name of names) {
  const tailText = args.nolora === true ? TAIL.replace(/\(@askzy \\\(askzy\\\):0\.8\),/, '') : TAIL
  const text = VARIANTS[name] + tailText
  const built = uiToApi(ui, objectInfo, { prompt: text, width: W, height: H })
  const p = JSON.parse(JSON.stringify(built.prompt))

  // steps / cfg / seed 在工作流里是连线（Switch / SeedNode）→ 换成字面值
  const sampler = Object.values(p).find((n) => n.class_type === 'KSampler')
  sampler.inputs.steps = STEPS
  sampler.inputs.cfg = 4.5
  sampler.inputs.seed = SEED
  p['92:74'].inputs.width = W
  p['92:74'].inputs.height = H

  if (FAST) {
    // 只留底图那条链：砍掉 放大(127/128)、修脸(163/172)、以及它们的预览
    strip(p, ['127', '128', '163', '172', '169', '173'])
  } else {
    p['127'].inputs.steps = 20
    p['172'].inputs.steps = 20
  }

  const id = await submit(p)
  console.log(`[${name}] 已提交 ${id}`)
  const entry = await waitFor(id)
  const files = []
  for (const [nodeId, out] of Object.entries(entry.outputs)) {
    for (const img of out.images ?? []) {
      const qs = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' })
      const buf = Buffer.from(await fetch(`${HOST}/view?${qs}`).then((r) => r.arrayBuffer()))
      const file = `${HERE}/out/${name}_${nodeId}_${img.filename}`
      await fsp.writeFile(file, buf)
      files.push(file)
    }
  }
  console.log(`[${name}] 出图: ${files.join(', ')}`)
}
