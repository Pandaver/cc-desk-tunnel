# Web 工作台中继（实验性）

中继是现有代理服务的可选模块，共用原镜像和容器。桌面主动连接服务端，浏览器通过服务端访问桌面已有的 Web 工作台；桌面不需要公网入站端口。前端、配对、浏览器授权与业务处理仍在桌面，不增加另一套工作台。

```text
浏览器 ── HTTP / WebSocket ── 服务端中继入口（容器 5270）
                                  ⇅
                       桌面主动建立的独立 WS/WSS
                       （原服务端口上的中继通道）
                                  ⇅
                           桌面本地 Web 服务
                                  │
                           原桌面工作台与执行通道
```

本地 Web 端口、容器中继端口和宿主对外端口互相独立：本地端口由桌面动态设置；容器中继入口固定为 `5270`；Docker 默认发布 `5270:5270`，也可部署为 `18080:5270` 等映射。修改桌面本地端口不改变公网访问地址，也不需要重建容器。

域名、证书、HTTPS 终止和 NGINX 由部署者管理。本模块不安装反向代理、不申请证书、不修改防火墙。原业务连接与 SSH 执行通道不承载 Web 转发数据。

## 启用

1. 使用包含本功能的服务端和桌面版本。本机、局域网 Web 功能仍可搭配未启用中继的原服务使用。
2. 部署时启用中继，发布中继入口。首次初始化例如：

   ```sh
   sudo bash deploy/manage.sh init --host VPS_IP --web-relay 1 --web-relay-port 5270
   sudo bash deploy/manage.sh build
   sudo bash deploy/manage.sh up
   ```

   `--web-relay-port` 设置宿主发布端口，不改变容器内端口。默认不启用中继，不增加端口映射或监听器。已有部署和纯镜像部署的配置见 [部署说明](../deploy/README.md)。改变端口映射后使用 `manage.sh up` 重建容器，仅重启进程不会修改 Docker 映射。
3. 桌面先按原方式连接代理服务，在“远程控制”启用 Web 工作台。中继使用该连接的服务地址、凭据和证书校验配置，不要求开启局域网监听。
4. 打开“通过服务端访问”。设置页显示服务端返回的只读访问地址；点击旁边的打开图标，浏览器自动配对。手工访问仍需配对。原服务凭据只用于桌面与服务端认证，不传给浏览器。

服务端按桌面连接的主机名、部署指定的对外端口和实际监听协议生成访问地址；部署时可用 `--web-relay-origin` 声明外层反代入口。桌面没有单独的公网地址或端口设置。直接 TLS 部署的中继监听器复用原服务证书；浏览器对证书的信任由浏览器自身管理，不继承桌面的指纹配置。HTTP 明文入口不提供链路加密。

桌面每次启动仍默认关闭中继。服务端只有显式启用才增加中继监听器；认证成功后才注册工作台并启动连接心跳。未注册的工作台入口返回 404。关闭 Web 工作台会一起关闭中继；仅关闭中继不影响本机、局域网 Web 或原业务连接。变更本地 Web 端口会重建中继连接，公网访问地址保持不变。

## 已有 NGINX 的部署

沿用 [NGINX 接入](../deploy/nginx.md) 的证书、端口和 `map` 配置。初始化时同时声明浏览器实际访问的 origin，例如：

```sh
sudo bash deploy/manage.sh init --host proxy.example.com --mode nginx \
  --url wss://proxy.example.com/ws --web-relay 1 \
  --web-relay-origin https://proxy.example.com
```

NGINX 模式下两个容器端口默认都只发布到宿主回环地址。在同一 `server` 块中增加以下规则。保留完整路径，`proxy_pass` 后不加用于替换路径的斜杠：

```nginx
location /_relay/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cc_desk_tunnel_connection;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
}

location /remote/ {
    proxy_pass http://127.0.0.1:5270;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $cc_desk_tunnel_connection;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 32m;
}
```

若修改了宿主控制端口，相应修改 `/_relay/` 的第一个 `proxy_pass`（以及原业务的上游）；若修改了宿主中继端口，则修改 `/remote/` 的第二个 `proxy_pass`。部署中的公网 origin 应与浏览器地址栏一致，使用外层 HTTPS 地址而不是容器内部 HTTP 地址。服务端沿用显式反代模式对 `X-Real-IP` 的信任；该模式下两个服务端端口都应只由受信任的反代访问。

## 通道与状态

- 原服务端口上的 `/_relay/control`：桌面注册、心跳、通知建立数据连接；使用独立中继协议版本，不改变原业务消息协议。
- 原服务端口上的 `/_relay/data`：按需建立的数据连接。首版每个 HTTP 请求使用一条数据连接，浏览器控制 WebSocket 使用自己的长连接。请求和响应采用流式传输，不将整个文件缓存到中继内存。
- 中继端口上的 `/remote/<工作台标识>/`：浏览器入口。页面、API 和 WebSocket 都保留此前缀，服务端转发时仅移除前缀。静态文件仍来自桌面的同一份前端构建。原服务端口不提供此入口，中继端口不提供业务连接或管理接口。
- 工作台标识跟随桌面设备及其连接配置；同时注册的不同工作台分别路由。重复注册不会踢掉原工作台。
- 中继使用启用时的连接配置快照。桌面业务连接断开或切换不会让现有浏览器被转发到另一台服务；如需更换中继服务，关闭后重新启用。
- 浏览器本地状态按 origin 隔离；Cookie 不按端口隔离，同一主机改变 Docker 映射端口可沿用登录，变更域名或访问协议后可能需要重新配对。
- 断线清理未完成请求与数据通道，控制连接退避重连。已经发送的 HTTP 写请求、终端输入和业务命令不会由中继自动重放。

## 边界

浏览器仍由桌面的配对码和有限期 Cookie 鉴权，授权撤销继续由桌面执行。中继认证桌面连接，并限制注册数、待接入连接、数据通道及等待时间；浏览器提供的内部中继头会被清除，桌面仅认可活动中继在回环连接上提交的上下文。来源检查保留，转发目标固定为该桌面自己启用的 Web 监听器。

不同工作台的 Cookie 路径和浏览器状态键分别命名，避免意外串用。相同 origin 下的路径不是互不信任用户之间的隔离边界：本功能仍是同一使用者的多设备入口，不是多租户托管。服务端会接触转发内容；两段 TLS 不等于穿过服务端的端到端加密。

功能关闭时的原业务行为、HTTP / WebSocket 转发、撤销授权、本地端口变更与连接清理由源码回归测试覆盖。真实公网环境、反代配置和长期运行需按实际部署验收；测试通过不代表已经完成公网或真实模型验收。
