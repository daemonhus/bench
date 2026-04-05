import React from 'react';

interface SearchBoxProps {
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  placeholder?: string;
}

export const SearchBox: React.FC<SearchBoxProps> = ({
  value,
  onChange,
  invalid = false,
  placeholder = 'Search…',
}) => (
  <div className={`annotation-search${invalid ? ' annotation-search-invalid' : ''}`}>
    <input
      type="search"
      className="annotation-search-input"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
    {value && (
      <button
        className="annotation-search-clear"
        onClick={() => onChange('')}
        title="Clear search"
        tabIndex={-1}
      >
        &#x2715;
      </button>
    )}
  </div>
);
