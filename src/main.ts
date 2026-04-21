import './style.css'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div class="card">
  <div class="ornament top">✦ ✦ ✦</div>

  <p class="invite-label">Приглашение</p>

  <div class="names">
    <span class="name">Александр</span>
    <span class="amp">&amp;</span>
    <span class="name">Мария</span>
  </div>

  <div class="divider">
    <span class="line"></span>
    <span class="heart">♥</span>
    <span class="line"></span>
  </div>

  <p class="announce">
    С радостью приглашаем вас разделить с нами<br>
    счастливый день нашего бракосочетания
  </p>

  <div class="details">
    <div class="detail">
      <span class="detail-label">Дата</span>
      <span class="detail-value">7 июня 2026</span>
    </div>
    <div class="detail-sep"></div>
    <div class="detail">
      <span class="detail-label">Время</span>
      <span class="detail-value">16:00</span>
    </div>
    <div class="detail-sep"></div>
    <div class="detail">
      <span class="detail-label">Место</span>
      <span class="detail-value">Ресторан «Усадьба»<br><small>ул. Садовая, 12, Москва</small></span>
    </div>
  </div>

  <div class="rsvp-section">
    <p class="rsvp-text">Пожалуйста, подтвердите своё присутствие<br>до 1 мая 2026</p>
    <a class="rsvp-btn" href="tel:+79001234567">Подтвердить</a>
  </div>

  <div class="ornament bottom">✦ ✦ ✦</div>
</div>
`