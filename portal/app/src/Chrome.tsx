// Header and footer as on AKC Tenant Audit (AKC-Audit src/components/site-chrome.tsx), which follows www.andykemp.com.
import type { ReactNode } from 'react';

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="site-header">
      <div className="wrap">
        <div className="brand">
          <a href="https://www.andykemp.com" aria-label="Andy Kemp Consulting home">
            <img className="logo" src="/assets/akc-logo-light.png" alt="Andy Kemp Consulting" width={475} height={182} />
          </a>
          <a className="subtitle" href="/">AVD Deploy</a>
        </div>
        <nav className="header-nav" aria-label="Main navigation">{children}</nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div>
          <img className="footer-logo" src="/assets/akc-logo-footer.png" alt="Andy Kemp Consulting" width={240} height={80} />
          <p>Microsoft 365 Security, Identity &amp; Tenant Migration Specialist</p>
          <p className="footer-note">Deploys into your own Azure subscription. Your desktops, data and passwords stay in your tenant.</p>
        </div>
        <div>
          <h2>Andy Kemp Consulting</h2>
          <ul>
            <li><a href="https://www.andykemp.com/services/">Services</a></li>
            <li><a href="https://tools.andykemp.com/">Free Tools</a></li>
            <li><a href="https://www.andykemp.com/blog/">Blog</a></li>
            <li><a href="https://www.andykemp.com/about/">About</a></li>
            <li><a href="https://www.andykemp.com/privacy/">Privacy</a></li>
          </ul>
        </div>
        <div>
          <h2>Get in Touch</h2>
          <ul>
            <li><a href="mailto:hello@andykemp.com">hello@andykemp.com</a></li>
            <li><a href="tel:+441313761802">+44 131 376 1802</a></li>
            <li><a href="https://www.andykemp.com/book-discovery-call/">Book a discovery call</a></li>
          </ul>
        </div>
      </div>
      <div className="footer-legal">
        <div className="wrap">
          <p>&copy; {new Date().getFullYear()} Andy Kemp Consulting Ltd. All rights reserved.</p>
          <p>Registered in Scotland &middot; Company No. SC878818 &middot; VAT No. GB513227917</p>
        </div>
      </div>
    </footer>
  );
}
