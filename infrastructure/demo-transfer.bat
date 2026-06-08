@echo off
echo ========================================================
echo     Riak High Availability (HA) & Hinted Handoff Demo
echo ========================================================
echo.

echo [1/5] BASELINE: Kiem tra cluster 3 Node khoe manh...
docker exec riak-node-1 riak-admin cluster status
echo.
echo ========================================================
echo [WEB ACTION]: Hay mo giao dien Web va them "Laptop" vao gio hang.
echo ========================================================
pause

echo.
echo [2/5] CHAOS: Tat dot ngot Node 3 de mo phong su co mat dien...
docker stop riak-node-3
echo -- Node 3 DA TAT --
echo.
echo ========================================================
echo [WEB ACTION]: Node 3 da chet. Hay quay lai Web va them "Mouse".
echo Giai thich: Web van hoat dong muot ma, khong he bao loi (Day la HA!)
echo Node 1 va 2 dang luu tam du lieu ho Node 3 (Fallback).
echo ========================================================
pause

echo.
echo [3/5] RECOVERY: Phuc hoi he thong, bat lai Node 3...
docker start riak-node-3
echo -- Node 3 dang khoi dong lai --
echo.
pause

echo.
echo [4/5] BEHIND THE SCENES: Xem Riak tra lai du lieu qua mang...
echo Node 1/2 se tra lai cac phan vung (partitions) cho Node 3.
echo --------------------------------------------------------
docker exec riak-node-1 riak-admin transfers
ping 127.0.0.1 -n 3 > nul 
echo.
docker exec riak-node-1 riak-admin transfers
echo --------------------------------------------------------
echo.
pause

echo.
echo [5/5] VERIFICATION: CRDT Tu dong gop du lieu!
echo ========================================================
echo [WEB ACTION]: Quay lai Web va xem lai gio hang.
echo Ket qua: Ban se thay day du ca "Laptop" va "Mouse". 
echo Node 3 da duoc dong bo tu dong va gop du lieu hoan hao!
echo ========================================================
echo.
echo Demo HA Hoan Tat!
pause