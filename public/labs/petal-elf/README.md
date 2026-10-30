# Petal elf feasibility trial

Standalone noindex trial at `/labs/petal-elf/index.html`. Loads the actual complete Blender model, rather than reconstructing the character in JavaScript. No account, billing, analytics, feedback or chat-message calls; wardrobe choices are session-only.

## Model

`models/petal-elf-v1.glb` contains the complete head, overlapping rear bonnet, leaf collar, body, arms, feet, portable vertex colours/base-colour/normal textures, sparse fibre geometry and one `Idle` transform animation. It uses `EXT_meshopt_compression` and `EXT_texture_webp`; the decoder is served locally. `HeadPivot`, `ArmLeft` and `ArmRight` are retained for procedural reactions. This is an articulated toy, not a skeletal walking/facial rig. Offline strand fur was deliberately replaced for realtime use. Approximately 202k rendered triangles; the current browser caps pixel ratio at1.5 and targets30fps. Real mobile GPU, memory, battery and Safari performance still require device testing.

The reference and editable Blender sources remain in the owner's local workspace (`temp/petal-elf/`). The single image's unseen surfaces are inferred. The user accepted this style for feasibility testing, not as an exact reconstruction of the original illustration.

## Controls and resilience

Pointer drag / left-right keys rotate. Native buttons provide pet/lift/spin/sleep reactions, reset, optional bow and a local PNG download. Reduced-motion starts paused; hidden pages do not render. A failed model request or lost WebGL context exposes a persistent reload button. No paid services or external asset requests are needed.

## Third-party code

Three.js r170, GLTFLoader, BufferGeometryUtils and RoomEnvironment: MIT, see `vendor/LICENSE-three.txt`. Meshoptimizer decoder0.18: MIT, see `vendor/MESHOPT-LICENSE.md`. The generated character model is a project asset, separate from these software licenses.

## Validation scope

Explicitly marked isolated Playwright browser runs cover320/390/1280widths, live animation versus paused frames, pointer/keyboard rotation, all actions, wardrobe, PNG download, reduced motion, RTL/200%zoom, failed-model recovery and zero business API requests. Native source and actual browser renders were visually reviewed. This page is a trial entrance, not an enabled pet overlay in 小微信 or剧情聊天.

<a id="zh"></a>

完整花瓣精灵的独立试验入口，加载真实 Blender GLB，包含身体与背面、待机动作和轻量交互。装扮不保存，不调用账号／计费／聊天／反馈接口。网页使用烘焙材质和稀疏绒毛几何，保留本地可编辑 Blender 源文件。当前是关节式玩偶试作，尚无行走骨架；实体手机性能与 Safari 待验证，未启用小微信／剧情聊天悬浮宠物。软件许可证与角色资产分开，验证范围见英文。
