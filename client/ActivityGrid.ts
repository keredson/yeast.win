import './activity.css';

export interface BrewerActivity {
  time_zone: string;
  start_date: string;
  through_date: string;
  total: number;
  days: { date: string; count: number }[];
}

function level(count: number): number {
  return count === 0 ? 0 : count < 2 ? 1 : count < 4 ? 2 : count < 7 ? 3 : 4;
}

export function renderActivityGrid(container: HTMLElement, activity: BrewerActivity): void {
  container.replaceChildren();
  const heading = document.createElement('div');
  heading.className = 'activity-heading';
  const title = document.createElement('h2');
  title.textContent = 'Activity';
  heading.append(title);
  const scroller = document.createElement('div');
  scroller.className = 'activity-scroll';
  const months = document.createElement('div');
  months.className = 'activity-months';
  const grid = document.createElement('div');
  grid.className = 'activity-grid';
  grid.setAttribute('role', 'img');
  grid.setAttribute('aria-label', `${activity.total} activity entries from ${activity.start_date} through ${activity.through_date} in ${activity.time_zone}`);
  const first = activity.days[0];
  let offset = 0;
  if (first) {
    const weekday = new Date(`${first.date}T00:00:00Z`).getUTCDay();
    offset = (weekday + 6) % 7;
    for (let index = 0; index < offset; index++) {
      const spacer = document.createElement('span');
      spacer.className = 'activity-blank';
      grid.append(spacer);
    }
  }
  const columns = Math.ceil((offset + activity.days.length) / 7);
  let previousMonth = '';
  let lastLabelColumn = -4;
  for (const [index, day] of activity.days.entries()) {
    const month = day.date.slice(0, 7);
    const column = Math.floor((offset + index) / 7);
    if (month !== previousMonth && column - lastLabelColumn >= 4) {
      const label = document.createElement('span');
      label.className = 'activity-month';
      label.style.left = `${column / columns * 100}%`;
      label.textContent = new Date(`${day.date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
      months.append(label);
      lastLabelColumn = column;
    }
    previousMonth = month;
    const cell = document.createElement('span');
    cell.className = `activity-day activity-level-${level(day.count)}`;
    cell.title = `${day.date}: ${day.count} ${day.count === 1 ? 'entry' : 'entries'}`;
    grid.append(cell);
  }
  scroller.append(months, grid);
  container.append(heading, scroller);
}
