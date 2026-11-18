'use strict';
const input = document.getElementById('url');
input.value = new URLSearchParams(location.search).get('current') || '';
document.getElementById('cancel').onclick = () => window.close();
document.getElementById('form').onsubmit = async e => {
  e.preventDefault();
  const r = await window.codebase.setServer(input.value);
  if (r && r.error) document.getElementById('err').textContent = r.error;
};
