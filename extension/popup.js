const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");

function checkServer() {
  const ws = new WebSocket("ws://localhost:3333/ws/viewer");
  ws.onopen = () => {
    dot.classList.add("ok");
    statusText.textContent = "Connected — Sharing active";
    ws.close();
  };
  ws.onerror = () => {
    dot.classList.remove("ok");
    statusText.textContent = "Server offline";
  };
}

checkServer();
