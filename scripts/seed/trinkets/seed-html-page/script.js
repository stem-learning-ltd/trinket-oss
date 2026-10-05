// The counter only goes up if script.js loaded and ran.
var clicks = 0;
document.getElementById('clicker').addEventListener('click', function () {
  clicks += 1;
  document.getElementById('count').textContent = 'Clicked ' + clicks + ' times.';
});
