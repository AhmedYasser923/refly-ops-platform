import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import reflyLogo from '../../assets/refly-logo.png';
import './Sidebar.css';

const toolItems = [
  { href: '/tools#announcements', panel: 'announcements', icon: '\uD83D\uDCE2', label: 'Announcements' },
  { href: '/tools#ticket-analyzer', panel: 'ticket-analyzer', icon: '\uD83C\uDFAB', label: 'Ticket Analyzer' },
  { href: '/tools#analyzer-v2', panel: 'analyzer-v2', icon: '\u25C8', label: 'Ticket Analyzer v2' },
  { href: '/tools#claim-intake', panel: 'claim-intake', icon: '\uD83E\uDDFE', label: 'Claim Intake' },
  { href: '/tools#barcode-decoder', panel: 'barcode-decoder', icon: <BarcodeIcon />, label: 'Barcode Decoder' },
  { href: '/tools#poa', panel: 'poa', icon: '\uD83D\uDCC4', label: 'POA Generator' },
  { href: '/tools#flight-search', panel: 'flight-search', icon: '\u2708', label: 'External Trackers' },
  { href: '/tools#eoc', panel: 'eoc', icon: '\u25CE', label: 'EOC Radar' },
  { href: '/tools#doc-check', panel: 'doc-check', icon: <DocCheckIcon />, label: 'Doc Check' },
  { href: '/tools#jurisdiction', panel: 'jurisdiction', icon: '\u2696', label: 'Jurisdiction' },
  { href: '/tools#iata', panel: 'iata', icon: <GlobeIcon />, label: 'IATA Lookup' },
  { href: '/tools#email', panel: 'email', icon: '\u2709', label: 'Email Builder' },
  { href: '/tools#ec261', panel: 'ec261', icon: '\u20AC', label: 'EC261 Calculator' },
  { href: '/tools#flight-stats', panel: 'flight-stats', icon: 'FS', label: 'FlightStats' }
];

const isActivePage = (location, href) => {
  const path = location.pathname;
  return path === href || (href !== '/' && path.startsWith(href));
};

const isActivePanel = (location, panel) => {
  const activeHash = location.hash || '#ticket-analyzer';
  return location.pathname === '/tools' && activeHash === `#${panel}`;
};

function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8" />
      <path d="M12 3c2.2 2.5 3.4 5.6 3.4 9s-1.2 6.5-3.4 9c-2.2-2.5-3.4-5.6-3.4-9s1.2-6.5 3.4-9z" />
    </svg>
  );
}

function DocCheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M9 15l2 2 4-4" />
    </svg>
  );
}

function BarcodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 5v14" />
      <path d="M7 5v14" />
      <path d="M11 5v14" />
      <path d="M14 5v14" />
      <path d="M17 5v14" />
      <path d="M20 5v14" />
    </svg>
  );
}

export default function Sidebar({ user }) {
  const location = useLocation();
  const { logout } = useAuth();
  const initial = user?.name ? user.name.charAt(0).toUpperCase() : 'U';

  const signOut = (event) => {
    event.preventDefault();
    logout();
  };

  return (
    <aside className="sidebar" id="sidebar">
      <div className="sidebar__logo">
        <img src={reflyLogo} alt="" aria-hidden="true" />
        <span className="sidebar__wordmark">Refly</span>
      </div>

      <nav className="sidebar__nav">
        <div className="sidebar__section">
          <div className="sidebar__section-header">Main</div>
          <Link className={`nav-item${isActivePage(location, '/') ? ' is-active' : ''}`} to="/" data-page="dashboard">
            <span className="nav-item__icon">
              <DashboardIcon />
            </span>
            <span className="nav-item__label">Dashboard</span>
          </Link>
        </div>

        <div className="sidebar__section-divider" />

        <div className="sidebar__section">
          <div className="sidebar__section-header">Tools</div>
          {toolItems.map((item) => (
            <Link
              className={`nav-item${isActivePanel(location, item.panel) ? ' is-active' : ''}`}
              to={item.href}
              data-panel={item.panel}
              key={item.panel}
            >
              <span className="nav-item__icon">{item.icon}</span>
              <span className="nav-item__label">{item.label}</span>
            </Link>
          ))}
        </div>

        {user?.role === 'admin' && (
          <>
            <div className="sidebar__section-divider" />
            <div className="sidebar__section">
              <div className="sidebar__section-header">Admin</div>
              <Link className={`nav-item${isActivePage(location, '/admin') ? ' is-active' : ''}`} to="/admin" data-page="admin">
                <span className="nav-item__icon">{'\u2699'}</span>
                <span className="nav-item__label">Admin Panel</span>
              </Link>
            </div>
          </>
        )}
      </nav>

      <div className="sidebar__footer">
        <a className="sidebar__signout" href="/logout" onClick={signOut} title="Sign Out">
          <span className="nav-item__icon">
            <SignOutIcon />
          </span>
          <span className="sidebar__signout-label">Sign Out</span>
        </a>
      </div>
    </aside>
  );
}
