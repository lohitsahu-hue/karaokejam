// Room View — room info, guest list
const RoomView = {
  init() {
    WS.on('guest:joined', (data) => this.updateGuests(data.guests, data.guestCount));
    WS.on('guest:left', (data) => this.updateGuests(data.guests, data.guestCount));
    WS.on('room:state', (data) => this.onRoomState(data.room));
  },

  show(room) {
    document.getElementById('room-code-display').textContent = room.code || room.roomCode;
    document.getElementById('room-host-name').textContent = `Host: ${room.hostName}`;
    this.updateGuests(room.guests, room.guests?.length || 0);
  },

  onRoomState(room) {
    this.show(room);
    QueueView.render(room.queue || []);
  },

  updateGuests(guests, count) {
    const el = document.getElementById('room-guests');
    if (count === 0) {
      el.textContent = 'No guests yet';
    } else {
      const names = guests.map(g => g.name).slice(0, 3).join(', ');
      const more = count > 3 ? ` +${count - 3}` : '';
      el.textContent = `${names}${more} (${count})`;
    }
  },
};