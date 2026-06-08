# Cấu hình & Kiến trúc Demo Riak KV

Tài liệu này tóm tắt cấu trúc hệ thống và các cấu hình quan trọng đã được thiết lập để phục vụ cho buổi demo Chaos Engineering với Riak KV.

## 1. Các Cấu Hình Quan Trọng (Riak KV Cluster)

Trước khi thực hiện demo, hệ thống đã được thiết lập với các thông số sau:

*   **Số lượng Node (N): `3`**
    *   Hệ thống chạy 3 node Riak KV (`riak-node-1`, `riak-node-2`, `riak-node-3`) thông qua Docker.
    *   Giá trị `N=3` (Replication Factor) nghĩa là mỗi mảnh dữ liệu sẽ được sao chép và lưu trữ trên cả 3 node này để đảm bảo tính dự phòng.
*   **Write Quorum (W): `1`**
    *   Khi ghi dữ liệu (thêm sản phẩm vào giỏ hàng), hệ thống chỉ yêu cầu **1 node** phản hồi thành công là thao tác ghi đã hoàn tất (High Availability).
    *   Điều này cho phép ứng dụng vẫn hoạt động mượt mà và nhận lệnh thêm vào giỏ hàng ngay cả khi 2/3 node trong hệ thống bị sập.
*   **Read Quorum (R): `1`**
    *   Khi đọc dữ liệu, hệ thống cũng chỉ cần đọc từ **1 node** phản hồi nhanh nhất.
    *   Tuy nhiên, do tính chất của Eventual Consistency và Read Repair, nếu đọc trúng node cũ, hệ thống sẽ trả về dữ liệu đó và sau đó ngầm đồng bộ lại với phiên bản mới nhất khi các node liên lạc với nhau qua Gossip Protocol.
*   **Bucket Type: `maps` (CRDTs)**
    *   Giỏ hàng được lưu trữ dưới dạng CRDT Maps (Conflict-Free Replicated Data Types).
    *   Đảm bảo khi các node hội tụ lại, các thao tác thêm/bớt sản phẩm sẽ tự động merge (hợp nhất) mà không gây ra xung đột dữ liệu (Eventual Consistency).

## 2. Sơ đồ Kiến Trúc (Architecture Diagram)

```mermaid
graph TD
    %% Định nghĩa các Client
    Client[Browser / React Frontend\nhttp://localhost:3000]

    %% Định nghĩa Backend
    subgraph "Backend Layer"
        Backend[Node.js Express Backend\nport: 3001]
    end

    %% Định nghĩa Riak Cluster
    subgraph "Riak KV Cluster (N=3, W=1, R=1)"
        Node1[(riak-node-1\nport: 8098)]
        Node2[(riak-node-2\nport: 8198)]
        Node3[(riak-node-3\nport: 8298)]
    end

    %% Luồng dữ liệu
    Client -->|Polling /api/health| Backend
    Client -->|Cart Ops /api/cart| Backend
    
    Backend -->|Promise.any() / Parallel Race| Node1
    Backend -->|Promise.any() / Parallel Race| Node2
    Backend -->|Promise.any() / Parallel Race| Node3
    
    %% Sync nội bộ cluster
    Node1 -.->|Gossip Protocol & Replication| Node2
    Node2 -.->|Gossip Protocol & Replication| Node3
    Node3 -.->|Gossip Protocol & Replication| Node1
```

### Giải thích luồng hoạt động trong Demo:
1.  **Frontend (React)** gọi API `/api/cart` tới Backend.
2.  **Backend (Node.js)** sử dụng chiến lược `Promise.any()` để gửi yêu cầu song song (Parallel Race) tới cả 3 node Riak cùng lúc. Node nào phản hồi nhanh nhất sẽ được lấy kết quả trả về cho Frontend.
3.  **Riak KV Cluster** tự động xử lý việc sao chép dữ liệu (Replication) nội bộ. Khi một node (ví dụ Node 3) bị ngắt kết nối, thao tác ghi vẫn thành công do `W=1` (chỉ cần 1 trong các node còn sống nhận được dữ liệu là đủ).
4.  Khi Node 3 hoạt động trở lại, các request đọc tiếp theo sẽ kích hoạt **Read Repair**, Node 3 sẽ được tự động đồng bộ lại dữ liệu.
