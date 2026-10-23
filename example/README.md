# 示例项目

这个目录是「演示数据」而不是插件源码的一部分：

- `example/.debate/` 里有一个可直接打开的示例辩论项目（`projects.project-demo-ai`，题目：人工智能的发展利大于弊，正方），
  以及公共证据库示例数据（均为公开可核验来源，卡片带 `source` / `url`）。
- 这些数据由插件自身的工具生成，**格式与 DebateWeaver 的 `ProjectExportBundle` 一致**，可以直接导入 DebateWeaver。

## 怎么用

1. 安装插件并重启 DSH 后，在对话里让模型把工作区指向本目录：

   ```
   debate_workbench(action=open, workspace="<仓库路径>/example")
   ```

   或者调用任意工具时显式传 `workspace`：

   ```
   debate_project(action=list, workspace="<仓库路径>/example")
   ```

2. 打开右栏「辩论工作台」即可看到示例论证树、证据卡、攻防框与拆题结果。

## 想清空演示数据

删除 `example/.debate/` 后重新创建一个题目即可：

```
debate_project(action=create, topic="你的辩题", side=正, workspace="<仓库路径>/example")
```

## 注意

- 示例证据卡里的数字/案例都来自公开报道与公开调查，**引用到真实比赛前请按卡片上的 `source` / `url` 复核原文**。
- 示例数据会随插件数据模型演进更新；如果发现示例读不出来，删除 `.debate/` 重新生成即可。
