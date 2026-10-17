# 王知之自习室 · 本地选座下单助手

给你自己用的一份本地小工具：**在电脑上选座、下单、用月卡抵扣到 ¥0**，并直接控制自己订单对应的门锁 / 签到 / 退座。
界面是一个尽量还原微信小程序外观的单页应用，跑在 `127.0.0.1:8790`。

> **自己用、只监听本机。** `auth.json` 里是你的 token，等于你的实名账号，别给别人、别把监听地址改成 `0.0.0.0`、别部署到公网。

---

## 快速开始

```bash
cd booking-assistant

# node 不在默认 PATH 里，用绝对路径（v24 起自带 fetch / WebSocket）
NODE=/Users/Apple/.nvm/versions/node/v24.19.0/bin/node

$NODE book.mjs          # 前台跑
# 或后台跑： nohup $NODE book.mjs > /tmp/book.log 2>&1 &

open http://127.0.0.1:8790
```

**零依赖、零构建**：不需要 `npm install`，没有 `node_modules`，`book.mjs` + `ui.html` 就是全部。

停止：`pkill -f "node book.mjs"`

---

## 文件

| 文件 | 说明 |
|---|---|
| `book.mjs` | 本地 HTTP 服务：静态托管 `ui.html` + 一组 JSON API（转发到王知之平台） |
| `ui.html` | 单文件前端，整个界面做成一个小程序外观（自写路由、弹窗、抽屉、toast） |
| `auth.json` | **你的凭证**：`{ token, ua, savedAt, source }`。**已被 .gitignore 排除，不要提交** |
| `auth.example.json` | 上面那份的样例形状，方便你换机器 |
| `zero_stores_seed.json` | 0 元门店兜底清单（实时拉取失败时用） |
| `probe.mjs` / `refresh-token.mjs` | 早期脚本，保留备查 |

---

## 凭证怎么换（不用重启）

token 与 `User-Agent` **绑死**：UA 里微信版本号只差一位，服务端就返回 `12002 Token失效`。
所以换包时 **token 和 UA 要一起换** —— 用「我的 → 更新 JWT token」从抓包里一键提取最稳。

- 服务每 2 秒检查一次 `auth.json` 的 mtime，**改完立即生效，不用重启**。
- 也可以直接编辑 `auth.json`：`{ "token": "eyJ...", "ua": "Mozilla/5.0 ... MicroMessenger/8.0.xx..." }`
- 保存前会拿新 token 打一次 `/fp/store/org/store-count` 探活，把结果告诉你。

---

## 能做什么

### ① 选座下单（核心）
`门店 → 选座 → 点座位 → 确认 → 下单 → 月卡抵扣`

- 只列 **月卡 0 元覆盖** 的门店（实时取自 `/card/available-stores`）。
- 下单后调 `changeTheTime` 用月卡抵扣：**扣月卡 1 天，实付 ¥0，订单直接变「已支付」**。
- **取消预约不退月卡天数** —— 实测「抵扣 → 取消」前后 `remainValue` 都是 26。取消只释放座位。

### ② 当前状况（选座页实时卡）
选座页顶部一张「当前状况」卡：服务端时间、营业状态、此刻座位（空 N · 占 N）、我正占着的座、我的订单、灯光、门锁状态。
数据来自 `live_situation/iz_open` + `live_situation/query` + 自己的订单。

### ③ 看占座的人 + 该座被预约的时段
座位图上**点占用的座位**：弹出半屏抽屉，显示那个人头像（方形，精确落在座位点上）、`userId` 尾号，
以及这个座**被占用的所有时间段**（来源 `/seat/querySeatSpareTime`，已标出「占用中 / 已被预约 / 已过去」）。
选座页还有一张「已经被谁占了什么时候」的**总览**（`/api/agenda`，把全场时段聚合按人数排序）。

> 平台**不暴露**别人的昵称或别人的订单：只有 `userPhoto` + `userId`，`getUserInfo` 这类只读接口实测全 404。

### ④ 提前入座 / 开门 / 退座 / 取消预约（订单详情页）
| 动作 | 接口 | 状态 |
|---|---|---|
| 开门 | `POST /seat/order/openDoor/judgment_condition` | ✅ 实测通（返回 `data.code 2000 门已开`） |
| 签到（到店入座） | `POST /seat/order/immediatelySeat` | ✅ 实测通（`329 立即入座成功`，订单 → 使用中） |
| 退座（结束本次学习） | `POST /seat/order/finishStudy` | ✅ 实测通（`325`，订单 → 8 已结束，座位立即释放） |
| 取消预约 | `POST /seat/order/cancelReservation` | ✅ 实测通（`328`，订单 → **4 已取消**，座位立即释放）<br>⚠️ **只对「已支付」的单有效**，待支付返回 `999998 取消预约失败` |
| 开灯 | `POST /seat/order/openLight` | ❌ 没跑通（有活跃订单时恒 `code 500` 空 msg；无活跃订单时 `100862`） |

**关于「提前 30 分钟取消」**：门店规则由 `GET /seat/order/{storeId}/queryCancelRule` 给出，
`aheadCancelBookingMinutes=30` 内取消算违约、按 `bookingAheadCloseDeductMinutes=30` 扣减。
订单详情页会按开始时间**实时判定**并显示绿/橙提示。
⚠️ 但要清楚：**取消不退月卡天数**（实测抵扣前后 `remainValue` 不变）。

**关于「开门要在 1km 内」**：那是**客户端自报坐标**，服务端只比「你报的位置 ↔ 门店坐标」的直线距离，
容差 = 门店字段 `storeDistanceStipulation`（实测 1000m）。请求体里 `lat/lon/wifiName/hardwareMessageId` 全部由客户端给。
**没有蓝牙、没有门店 WiFi**，所以本工具直接提交订单自带的门店坐标（距离≈0）。

⚠️ 但请**只开自己的门**：这不是权限漏洞，开的仍是自己订单对应的锁，但它的校验形同虚设。

**注意**：签到会**自动把灯点亮**、并把预约窗口重定基（改成「签到那一刻 + 原时长」）；退座会把灯关掉。
所以想要灯亮，点签到就够了，不用管那个坏掉的 `openLight`。

### ⑤ 人脸门禁（我的页）
上传一张正脸照片 → 传平台 OSS → 建立人脸档。建完之后**到门禁机刷脸就行，不用每次在网页点开门**。

链路（从「上传人脸」抓包里逆出来的）：
1. `POST /opsli-boot/api/v1/store/home/page/upload/file` —— multipart，字段名 `file`。
   ※ 注意这条**不在 `/applet` 下**，而且**不带 `Authorization`**，只认 UA + Referer。
2. `POST /opsli-boot/api/v1/applet/user-face/create` —— JSON `{ url, appId }`。

平台**没有**「查是否已建过脸」的接口（24 个候选名全 404），所以界面显示不了状态；**重复上传会覆盖旧的脸**，也没有删除接口。

### ⑥ 订单
「预约」页**直接列出当前预约**，不用先查单。
`getUserTogether` 只返回**活跃**订单 —— 退座 / 结束后就从列表消失，所以工具在**本机 `localStorage`** 留了一份足迹（「本机记录」），
已结束的单点一下就能回查（走 `/api/order?orderId=`）。

---

## 做不到的（别在这上面浪费时间）

- ~~**取消订单**：平台没暴露接口~~ → **已推翻**。这轮扩到 840 个候选（12 前缀 × 70 名字）扫出
  `POST /seat/order/cancelReservation`（form-urlencoded，只需 `orderId`）。
  **但只对「已支付」的单有效**：待支付的单返回 `999998 取消预约失败`。
- **退卡 / 退款**：仍然没有。取消不退月卡天数。
- **微信支付**：要客户端 + 商户号；0 元店用不上。
- **查别人昵称 / 别人的订单**：只有 `userPhoto` + `userId`。
- **补差价升级 / 自助转让**：`userUpgrade` 返回「该方法已废弃」；转让只有店长人工流程。
- **改座位数量 / 换座**：`changeSeat` 端点存在（form-urlencoded），但参数未知、破坏性强，**故意没接**。

---

## 接口链（全流程）

```
appletLogin                    code → JWT（HAR 里拿不到 code，只能手抓 token）
fp/store/org/store-count       探活：能返回门店数 = token 有效
card/available-stores          月卡 0 元覆盖门店清单
fp/store/org/getStoreBrief     门店列表（分页）
sp/store/org/getStoreDetail    门店详情（含 storeDistanceStipulation / 营业时间 / 座位数）
store-space-booking-prices/list 座位单价
store/live_situation/iz_open   门店是否在营业
store/live_situation/query     座位图 + 每座占用者 userId/userPhoto
seat/querySeatSpareTime        某座被占用的时间段
seat/order/chooseSeatNow       选座前置校验
seat/order/confirmSeat         下单
seat/order/wechat-order-amt/{orderId}  待付金额
seat/order/changeTheTime       月卡抵扣（结算）→ orderStatus 1→3
seat/order/queryOrderDetails   订单详情（设备 / 灯光 / 可提前开门分钟数）
seat/order/openDoor/judgment_condition  开门
seat/order/immediatelySeat     签到 / 立即入座
seat/order/finishStudy         退座 / 结束学习
seat/order/cancelReservation   取消预约（form-urlencoded，只对已支付单有效）
card/user_cards                用户全部卡券（无需入参）——月卡余额/截止日期的权威来源
store/home/page/upload/file    人脸照片传 OSS（不带 Authorization）
user-face/create               人脸建档
op/store/org/getUserTogether   当前预约列表
```

**orderStatus 枚举**（实测）：`1` 待支付 · `3` 已支付待使用 · `4` **已取消** · `6` 使用中 · `8` 已结束。

---

## 几个踩过的坑

- `queryOrderDetails` 是 **GET + query 参数**，用 POST body 会 500。
- 平台未知路由返回 **HTTP 404 + Spring 风格 `{"status":404,"error":"Not Found"}`**，**没有 `code` 字段** ——
  探接口时判 `j.code === 404` 会把所有 404 误判成「端点存在」。
- 各接口 body 格式不统一：`finishStudy`/`immediatelySeat` 只认 **form-urlencoded**，`openLight`/`judgment_condition` 只认 **JSON**（传错分别报「订单号不能为空」/ HTTP 415）。
- 订单号格式校验很严：`YYYYMMDDHHmmssSSS-` 后接**恰好 14 字符**。探接口请用**格式合法但不存在的**假单号，别拿真单试破坏性接口。
- 本机 Chrome 无头 + CDP（原生 `WebSocket` 直连）可以驱动真实浏览器做 DOM 断言，用来替代肉眼看截图。


## 订单历史 / 换座 / 延长（第三轮补充）

### 订单从哪来
| 用途 | 接口 | 说明 |
|---|---|---|
| **当前预约** | `GET /op/store/org/getUserTogether` | 只返回**活跃**单；一单退座/取消后立刻从这里消失 |
| **历史订单** | `GET /seat/order/querySeatOrderList?pageNo&pageSize` | 全量历史，翻到空页为止。`/api/orders` 默认给**近 3 天**（`?all=1` 给全部） |

`querySeatOrderList` 的单条字段：`orderId / fullName / orderStatus / areaName / studyDate / startTime / endTime / spaceName / seatName / seatId / periodTime`。
它**不返回状态文案**，只有数字。`/api/orders` 把 `statusMap`（即下面的枚举）一并下发，前端自己映射。

### orderStatus 枚举（实测来源标在括号里）
| 码 | 含义 | 依据 |
|---|---|---|
| 1 | 待支付 | 实证 |
| 3 | 已支付（待使用） | 实证 |
| 4 | 已取消 | 实证（`cancelReservation` 后 3 → 4） |
| 5 | 已完成 | **推断**（只在历史列表里见过，没在 App 界面对过） |
| 6 | 使用中 | 实证 |
| 7 | 已结束 | **推断**（同上） |
| 8 | 已结束（退座） | 实证（`finishStudy` 后 6 → 8） |

### 换座
`POST /seat/order/changeSeat`，**form-urlencoded**：`orderId` + `seatId`（要换到的新座位）+ 可选 `spaceId` / `storeId`。

> ⚠ 这个接口**用已结束/已取消的单调用也会返回 `code 200 操作成功！`，但什么都不改**。
> 所以 `/api/changeSeat` **不信响应码，只认回读**：拿 `queryOrderDetails` 回读 `seatId`，变了才算成功。
> 参数名是按平台命名习惯推的，**没能在活跃订单上实测**（账号被平台限制建单）。

### 延长时间
平台**没有独立的延长接口**（`/seat/order/` 下 60 个候选路径全 404）。延长走的就是 `changeTheTime` ——
它的请求体里本来就有 `extendOrderId` 字段。

> ⚠ 参数未实测。用已结束/已取消的单能探到的必填链是：`orderId` → `type` → 「支付方式不能为空」（再往下就断了）。
> `/api/extend` 会带上 `extendOrderId` 发一次，并把服务端**原样返回**给你看，成功与否以**回读结束时间有没有变**为准。

### 人脸门禁
`POST /store/home/page/upload/file`（multipart，字段名 **`file`**，**不在 `/applet` 下、不带 Authorization**，只认 UA + Referer）
→ 返回 OSS URL → `POST /applet/user-face/create`（JSON `{url, appId}`，`data:true`=更新 `false`=新建）。

**注意：这是真的会建/覆盖人脸档，而平台没有删除接口。** 所以 `/api/face` 必须带 `confirm:true`，
开发时用 `uploadOnly:true` 只验证上传通道、不建档。

### 座位坐标系
官方小程序的座位定位是 `left/top` = **左上角**，而早先这版按「中心点」画（`transform:translate(-50%,-50%)`），
整体会偏半个座位宽 —— 这就是「头像没落在座位点上」的成因。
`.map.anchor-tl` / `.map.anchor-c` 两个 class 对应两种坐标系，选座页有开关，默认 **左上角**，记在 `localStorage`。

### 品牌色
`GET /console_show/colorShow` 实测返回 **`#0052D9`** —— 王知之的品牌色是**蓝色**，不是微信绿。
界面主色已改为它。小程序 logo 从 `GET /fp/photo/org/getAppletMessage` 拿到，就是根目录的 `favicon.png` / `apple-touch-icon.png`。
