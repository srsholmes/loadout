# LSFG-VK

> Install and configure the LSFG-VK Vulkan frame generation layer

Installs and configures the LSFG-VK Vulkan frame-generation layer and applies it per game, boosting perceived frame rate on titles that run below your display's refresh. Set it up once and toggle it where it actually helps.

## Requirements

**Requires [Lossless Scaling](https://store.steampowered.com/app/993090/)** — a
paid third-party Steam app. LSFG-VK reuses Lossless Scaling's frame-generation
model, so the plugin detects an existing `Lossless Scaling` install and won't
work without it. The plugin downloads the open-source
[`lsfg-vk`](https://github.com/PancakeTAS/lsfg-vk) Vulkan layer itself, but the
underlying frame-gen tech is not free or bundled.

## Screenshots

![LSFG-VK](./assets/screenshot.png)

## See also

- [All plugins](../../README.md#plugins)
- [Plugin model](../../README.md#plugin-model)
