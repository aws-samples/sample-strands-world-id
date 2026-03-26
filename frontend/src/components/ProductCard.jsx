const categoryIcons = {
  CPU: '🔲',
  GPU: '🎮',
  RAM: '📊',
  Storage: '💾',
  Motherboard: '🔧',
  PSU: '⚡',
  Case: '🖥️',
  Cooler: '❄️',
};

function ProductCard({ product }) {
  const formatPrice = (price) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
    }).format(price);
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
    });
  };

  return (
    <div className="product-card">
      <div className="product-image">
        {categoryIcons[product.category] || '📦'}
      </div>
      <div className="product-info">
        <span className="product-category">{product.category}</span>
        <h3 className="product-name">{product.name}</h3>
        <p className="product-brand">{product.brand}</p>
        <p className="product-description">{product.description}</p>
        <div className="product-footer">
          <span className="product-price">{formatPrice(product.price)}</span>
          <span className="product-date">Released {formatDate(product.releaseDate)}</span>
        </div>
      </div>
    </div>
  );
}

export default ProductCard;
